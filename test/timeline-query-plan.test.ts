import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { migrateDatabaseSchema } from "../src/main/persistence/schema";
import type { Entry, EntryPageQuery } from "../src/shared/types";

let db: ReadingDatabase;
let sourceId: string;
const raw = (database: ReadingDatabase) => (database as unknown as { db: Sqlite.Database }).db;

function populate(database: ReadingDatabase, count: number): string {
  const source = database.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
  const entries: Entry[] = Array.from({ length: count }, (_, index) => ({
    id: `entry-${String(index).padStart(6, "0")}`, sourceId: source.id,
    canonicalUrl: `https://example.com/${index}`, url: `https://example.com/${index}`,
    title: `Fixture ${index}`, contentHash: `fixture-${index}`,
    createdAt: 1_700_000_000_000 + index, observedAt: 1_700_000_000_000 + (index % 300),
    publishedAt: index % 5 === 0 ? undefined : 1_600_000_000_000 + (index % 200),
    read: index % 2 === 0, favorite: index % 7 === 0, ingestionKind: index % 3 === 0 ? "history" : "current"
  }));
  database.saveEntries(entries);
  database.writeTransaction(() => {
    for (const entry of entries) {
      if (entry.read) database.markRead(entry.id, true);
      if (entry.favorite) database.markFavorite(entry.id, true);
    }
  });
  raw(database).exec("ANALYZE");
  return source.id;
}

/** Explain the actual SQL and bound cursor/filter values emitted by the repository. */
function pagePlan(database: ReadingDatabase, query: EntryPageQuery) {
  const native = raw(database);
  const prepare = native.prepare.bind(native);
  let captured: { sql: string; parameters: unknown[] } | undefined;
  const spy = vi.spyOn(native, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("FROM entries") && sql.includes("ORDER BY") && sql.includes("LIMIT ?")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...parameters: unknown[]) => {
        captured = { sql, parameters };
        return all(...parameters);
      });
    }
    return statement;
  });
  try { expect(database.listEntryPage(query).entries.length).toBeGreaterThan(0); }
  finally { spy.mockRestore(); }
  expect(captured).toBeDefined();
  return native.prepare(`EXPLAIN QUERY PLAN ${captured!.sql}`).all(...captured!.parameters) as Array<{ detail: string }>;
}

beforeAll(() => { db = new ReadingDatabase(":memory:"); sourceId = populate(db, 5_000); });
afterAll(() => db.close());

describe("publication timeline indexing", () => {
  it("keeps the legacy comparator for nulls, timestamp ties and later publication updates", () => {
    const database = new ReadingDatabase(":memory:");
    try {
      populate(database, 300);
      const native = raw(database);
      const update = native.prepare("UPDATE entries SET published_at = ?, observed_at = ?, created_at = ? WHERE id = ?");
      const dates = [null, Number.MIN_SAFE_INTEGER, -100, 0, 0.5, 100];
      database.writeTransaction(() => {
        for (let index = 0; index < 300; index++) update.run(dates[index % dates.length], index % 4 ? 10 : null, 10 + index % 3, `entry-${String(index).padStart(6, "0")}`);
      });
      // Independent SQL oracle from v9, including a dated value equal to the
      // null sentinel. Group membership must still put every dated card first.
      const expected = () => (native.prepare(`SELECT id FROM entries ORDER BY
        CASE WHEN published_at IS NULL THEN 1 ELSE 0 END ASC,
        COALESCE(published_at, -9007199254740991) DESC,
        COALESCE(observed_at, created_at) DESC, created_at DESC, id DESC`).all() as Array<{ id: string }>).map((row) => row.id);
      const verify = () => {
        const query: EntryPageQuery = { pageSize: 7 };
        const ids: string[] = [];
        do {
          const page = database.listEntryPage(query);
          ids.push(...page.entries.map((entry) => entry.id));
          query.cursor = page.nextCursor;
        } while (query.cursor && ids.length <= 300);
        expect(ids).toEqual(expected());
        expect(query.cursor).toBeUndefined();
      };
      verify();
      const entry = database.getEntry("entry-000000")!;
      expect(entry.publishedAt).toBeUndefined();
      expect(database.saveEntries([{ ...entry, publishedAt: 200 }])).toBe(0);
      expect(database.listEntryPage().entries[0].id).toBe(entry.id);
      verify();
    } finally { database.close(); }
  });

  it.each([
    ["dated", false], ["undated", false], ["dated", true], ["undated", true]
  ] as const)("seeks all publication tie-breakers for a %s cursor (unread: %s)", (group, unread) => {
    const query: EntryPageQuery = { pageSize: 100, ...(unread ? { read: false } : {}) };
    const entries = db.listEntries({ ...query, limit: 5_000 });
    const candidates = entries.filter((entry) => (entry.publishedAt === undefined) === (group === "undated"));
    const boundary = candidates.at(-150)!;
    query.cursor = { publishedAt: boundary.publishedAt, observedAt: boundary.observedAt!, createdAt: boundary.createdAt, id: boundary.id };
    const plan = pagePlan(db, query);
    expect(plan.some((row) => /SEARCH entries USING INDEX entries_(publication_order|timeline).*created_at,id\).*<\(/.test(row.detail)), JSON.stringify(plan)).toBe(true);
    expect(plan.filter((row) => /TEMP B-TREE/i.test(row.detail))).toEqual([]);
    const offset = entries.findIndex((entry) => entry.id === boundary.id) + 1;
    expect(db.listEntryPage(query).entries).toEqual(entries.slice(offset, offset + 100));
  });

  it.each(["current", "history"] as const)("seeks directly to an older %s collection page", (collection) => {
    const query: EntryPageQuery = { collection, sort: "collected", pageSize: 100 };
    // Jump near the end of the library; a small LIMIT alone does not prevent
    // the query from scanning every newer card before applying its cursor.
    const entries = db.listEntries({ collection, sort: "collected", limit: 5_000 });
    const boundary = entries.at(-150)!;
    query.cursor = { createdAt: boundary.createdAt, observedAt: boundary.observedAt!, id: boundary.id };
    const plan = pagePlan(db, query);
    expect(plan.some((row) => /SEARCH entries USING INDEX entries_collection.*created_at.*</.test(row.detail)), JSON.stringify(plan)).toBe(true);
    expect(plan.filter((row) => /TEMP B-TREE/i.test(row.detail))).toEqual([]);
    const offset = entries.findIndex((entry) => entry.id === boundary.id) + 1;
    expect(db.listEntryPage(query).entries).toEqual(entries.slice(offset, offset + 100));
  });

  it("preserves collection order across timestamp ties and a deleted cursor", () => {
    const database = new ReadingDatabase(":memory:");
    try {
      const sourceId = populate(database, 300);
      // Historical imports often give a whole batch one collection time.
      raw(database).exec("UPDATE entries SET created_at = 100 + (rowid % 3)");
      database.dismissEntry("entry-000042");
      database.dismissEntry("entry-000043");
      const queries: EntryPageQuery[] = [
        { collection: "current" }, { collection: "history" }, { dismissed: true },
        { sourceId, collection: "current", read: true }, { favorite: true }
      ];
      for (const filter of queries) {
        const query: EntryPageQuery = { ...filter, sort: "collected", pageSize: 7 };
        const expected = database.listEntries({ ...query, limit: 5_000 });
        const actual: Entry[] = [];
        do {
          const page = database.listEntryPage(query);
          actual.push(...page.entries);
          query.cursor = page.nextCursor;
        } while (query.cursor && actual.length <= expected.length);
        expect(actual).toEqual(expected);
        expect(query.cursor).toBeUndefined();
      }
      const query: EntryPageQuery = { collection: "current", sort: "collected", pageSize: 7 };
      const expected = database.listEntries({ ...query, limit: 5_000 });
      const first = database.listEntryPage(query);
      database.dismissEntry(first.nextCursor!.id);
      // Continuation is a position, not a lookup of a row that must still exist.
      expect(database.listEntryPage({ ...query, cursor: first.nextCursor }).entries).toEqual(expected.slice(7, 14));
    } finally { database.close(); }
  });

  it.each(["initialization", "migration"] as const)("closes a database handle after failed %s and permits retry", (phase) => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-open-failure-"));
    const path = join(directory, "fixture.sqlite");
    let failed: Sqlite.Database | undefined;
    const original = Sqlite.prototype.pragma;
    const pragma = vi.spyOn(Sqlite.prototype, "pragma").mockImplementation(function (this: Sqlite.Database, statement, options) {
      if (phase === "initialization" || statement === "optimize") {
        failed = this;
        throw new Error("Synthetic database initialization failure");
      }
      return original.call(this, statement, options);
    });
    try {
      expect(() => new ReadingDatabase(path)).toThrow("Synthetic database initialization failure");
      expect(failed?.open).toBe(false);
      pragma.mockRestore();
      const retried = new ReadingDatabase(path);
      try { expect(retried.listSources()).toEqual([]); }
      finally { retried.close(); }
    } finally { pragma.mockRestore(); if (failed?.open) failed.close(); rmSync(directory, { recursive: true }); }
  });

  it.each(["all", "unread", "favorite", "source", "continuation"] as const)("reads the %s page without a temporary ordering tree", (mode) => {
    const query: EntryPageQuery = { pageSize: 100 };
    if (mode === "unread") query.read = false;
    if (mode === "favorite") query.favorite = true;
    if (mode === "source") query.sourceId = sourceId;
    if (mode === "continuation") query.cursor = db.listEntryPage(query).nextCursor;
    const plan = pagePlan(db, query);
    expect(plan.filter((row) => /TEMP B-TREE/i.test(row.detail))).toEqual([]);
  });

  it.each([8, 9])("upgrades a v%s database atomically without changing retained data", (version) => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-index-"));
    const path = join(directory, "fixture.sqlite");
    let database = new ReadingDatabase(path);
    try {
      const sourceId = populate(database, 300);
      database.dismissEntry("entry-000042");
      const native = raw(database);
      const queries: EntryPageQuery[] = [{ pageSize: 200 }, { read: false }, { favorite: true }, { dismissed: true, sort: "collected" }, { cursor: database.listEntryPage().nextCursor }];
      const publicationQueries: EntryPageQuery[] = [{}, { read: false }, { favorite: true }, { sourceId }, { cursor: database.listEntryPage().nextCursor }];
      const before = queries.map((query) => database.listEntryPage(query));
      const revision = database.getLibraryRevision();
      // Recreate the actual old schema, including absence of generated keys.
      native.exec(`DROP INDEX entries_publication_order; DROP INDEX entries_timeline;
        ALTER TABLE entries DROP COLUMN timeline_group;
        ALTER TABLE entries DROP COLUMN timeline_published;
        ALTER TABLE entries DROP COLUMN timeline_observed;
        DELETE FROM schema_migrations WHERE version > ${version};`);
      const oldOrder = "CASE WHEN published_at IS NULL THEN 1 ELSE 0 END ASC, COALESCE(published_at, -9007199254740991) DESC, COALESCE(observed_at, created_at) DESC, created_at DESC, id DESC";
      if (version === 8) native.exec("CREATE INDEX entries_timeline ON entries(is_read, published_at DESC, created_at DESC)");
      else native.exec(`CREATE INDEX entries_timeline ON entries(is_read, ${oldOrder}); CREATE INDEX entries_publication_order ON entries(${oldOrder})`);
      const rows = () => native.prepare("SELECT * FROM entries ORDER BY id").all();
      const beforeRows = rows();
      const schema = () => native.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'entries' ORDER BY name").all();
      const previousSchema = schema();
      const optimize = vi.spyOn(native, "pragma").mockImplementationOnce(() => { throw new Error("Synthetic index migration failure"); });
      try { expect(() => migrateDatabaseSchema(native)).toThrow("Synthetic index migration failure"); }
      finally { optimize.mockRestore(); }
      expect(schema()).toEqual(previousSchema);
      expect(native.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version });
      expect(rows()).toEqual(beforeRows);
      database.close(); database = new ReadingDatabase(path);
      expect(queries.map((query) => database.listEntryPage(query))).toEqual(before);
      expect(database.getLibraryRevision()).toBe(revision);
      expect(database.listEntries({ dismissed: true }).map((entry) => entry.id)).toEqual(["entry-000042"]);
      for (const query of publicationQueries) expect(pagePlan(database, query).filter((row) => /TEMP B-TREE/i.test(row.detail))).toEqual([]);
      // The physical row values survive unchanged; virtual keys are derived.
      const current = raw(database);
      const columns = (current.pragma("table_info(entries)") as Array<{ name: string }>).map((column) => column.name);
      expect(current.prepare(`SELECT ${columns.join(",")} FROM entries ORDER BY id`).all()).toEqual(beforeRows);
      database.close(); database = new ReadingDatabase(path);
      expect(queries.map((query) => database.listEntryPage(query))).toEqual(before);
    } finally { database.close(); rmSync(directory, { recursive: true }); }
  });
});
