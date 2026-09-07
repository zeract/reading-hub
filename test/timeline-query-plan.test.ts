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

  it("upgrades a v8 database without changing any retained page, read state, or tombstone", () => {
    const directory = mkdtempSync(join(tmpdir(), "timeline-index-"));
    const path = join(directory, "fixture.sqlite");
    let database = new ReadingDatabase(path);
    try {
      const sourceId = populate(database, 300);
      database.dismissEntry("entry-000042");
      const native = raw(database);
      // Recreate the exact pre-upgrade indexes even when this fixture starts
      // under a newer binary; all row data and library revisions stay intact.
      native.exec(`DROP INDEX IF EXISTS entries_publication_order;
        DROP INDEX entries_timeline;
        CREATE INDEX entries_timeline ON entries(is_read, published_at DESC, created_at DESC);
        DELETE FROM schema_migrations WHERE version = 9;`);
      const queries: EntryPageQuery[] = [{ pageSize: 200 }, { read: false }, { favorite: true }, { dismissed: true, sort: "collected" }];
      const publicationQueries: EntryPageQuery[] = [{}, { read: false }, { favorite: true }, { sourceId }, { cursor: database.listEntryPage().nextCursor }];
      const temporarySorts = (query: EntryPageQuery) => pagePlan(database, query).filter((row) => /TEMP B-TREE/i.test(row.detail));
      expect(publicationQueries.every((query) => temporarySorts(query).length > 0)).toBe(true);
      const before = queries.map((query) => database.listEntryPage(query));
      const revision = database.getLibraryRevision();
      const indexes = () => native.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'entries' ORDER BY name").all();
      const previousIndexes = indexes();
      const optimize = vi.spyOn(native, "pragma").mockImplementationOnce(() => { throw new Error("Synthetic index migration failure"); });
      try { expect(() => migrateDatabaseSchema(native)).toThrow("Synthetic index migration failure"); }
      finally { optimize.mockRestore(); }
      expect(indexes()).toEqual(previousIndexes);
      expect(native.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 8 });
      expect(queries.map((query) => database.listEntryPage(query))).toEqual(before);
      database.close(); database = new ReadingDatabase(path);
      expect(queries.map((query) => database.listEntryPage(query))).toEqual(before);
      expect(database.getLibraryRevision()).toBe(revision);
      expect(database.listEntries({ dismissed: true }).map((entry) => entry.id)).toEqual(["entry-000042"]);
      expect(publicationQueries.map(temporarySorts)).toEqual([[], [], [], [], []]);
    } finally { database.close(); rmSync(directory, { recursive: true }); }
  });
});
