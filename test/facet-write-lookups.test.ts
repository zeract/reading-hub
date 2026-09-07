import type Sqlite from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import type { Entry } from "../src/shared/types";

const native = (db: ReadingDatabase) => (db as unknown as { db: Sqlite.Database }).db;
const facet = { scheme: "fixture", key: "topic", label: "Topic" };
const source = (db: ReadingDatabase) => db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
const card = (sourceId: string, id: string): Entry => ({ id, sourceId, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`, title: id, contentHash: id, providerId: "rss", createdAt: 1, read: false, favorite: false, facets: [facet] });
afterEach(() => vi.restoreAllMocks());

it("saves a large classified batch without rereading each facet ID", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const id = source(db).id;
    const raw = native(db);
    const prepare = raw.prepare.bind(raw);
    let lookups = 0;
    vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (/^SELECT id FROM facets WHERE/.test(sql)) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...parameters: unknown[]) => { lookups++; return get(...parameters); });
      }
      return statement;
    });
    expect(db.saveEntries(Array.from({ length: 5_000 }, (_, index) => card(id, String(index))))).toBe(5_000);
    expect(db.listSourceFacets(id)).toEqual([{ ...facet, sourceId: id, entryCount: 5_000 }]);
    expect(lookups).toBe(0);
  } finally { db.close(); }
});

it("retains the same facet ID and references across scope and content label updates", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const id = source(db).id;
    db.updateSubscriptionScope(id, { facetSelections: [facet], history: { mode: "none" } });
    const row = native(db).prepare("SELECT id FROM facets").get();
    db.saveEntries([{ ...card(id, "one"), facets: [{ ...facet, label: "Publisher label" }] }]);
    expect(native(db).prepare("SELECT id FROM facets").get()).toEqual(row);
    expect(db.getSubscriptionForSource(id)?.scope.facetSelections).toEqual([{ ...facet, label: "Publisher label" }]);
    db.updateSubscriptionScope(id, { facetSelections: [{ ...facet, label: "Updated label" }], history: { mode: "none" } });
    expect(db.getEntry("one")?.facets).toEqual([{ ...facet, label: "Updated label" }]);
    expect(db.listEntries({ sourceId: id, facetSelections: [facet] })).toHaveLength(1);
    expect(native(db).prepare("SELECT id FROM facets").get()).toEqual(row);
  } finally { db.close(); }
});

it("rolls back facet writes and references when a later entry fails, then retries cleanly", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const id = source(db).id;
    const revision = db.getLibraryRevision();
    expect(() => db.saveEntries([card(id, "one"), card("missing-source", "two")])).toThrow(/FOREIGN KEY/);
    for (const table of ["facets", "entry_origin_facets", "entries"]) {
      expect(native(db).prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.getLibraryRevision()).toBe(revision);
    expect(db.saveEntries([card(id, "one")])).toBe(1);
    expect(db.getEntry("one")?.facets).toEqual([facet]);
  } finally { db.close(); }
});
