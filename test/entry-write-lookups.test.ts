import type Sqlite from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import type { Entry } from "../src/shared/types";

const native = (db: ReadingDatabase) => (db as unknown as { db: Sqlite.Database }).db;
const card = (sourceId: string, id: string, overrides: Partial<Entry> = {}): Entry => ({
  id, sourceId, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`,
  title: id, contentHash: id, providerId: "rss", read: false, favorite: false, createdAt: 1_800_000_000_000,
  ...overrides
});
afterEach(() => vi.restoreAllMocks());

it("uses one canonical lookup per accepted card for both inserts and duplicate replays", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
    const raw = native(db);
    const prepare = raw.prepare.bind(raw);
    let lookups = 0;
    vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (/^SELECT .* FROM entries WHERE canonical_url = \?$/.test(sql)) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...parameters: unknown[]) => { lookups++; return get(...parameters); });
      }
      return statement;
    });
    const entries = Array.from({ length: 5_000 }, (_, index) => card(source.id, `fixture-${index}`, { ingestionKind: index % 2 ? "history" : "current" }));
    expect(db.saveEntries(entries)).toBe(5_000);
    expect(lookups).toBe(5_000);
    lookups = 0;
    expect(db.saveEntries(entries.map((entry) => ({ ...entry, id: `replay-${entry.id}`, title: "Updated fixture" })))).toBe(0);
    expect(lookups).toBe(5_000);
    expect(db.getLibraryCounts()).toMatchObject({ collected: 2_500, history: 2_500 });
  } finally { db.close(); }
});

it("attaches duplicate origins and facets to the retained ID within one batch", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const first = db.createSource({ url: "https://example.com/a", title: "First", kind: "rss", pollingEnabled: true });
    const second = db.createSource({ url: "https://example.com/b", title: "Second", kind: "rss", pollingEnabled: true });
    const original = card(first.id, "retained");
    const facet = { scheme: "fixture", key: "topic", label: "Topic" };
    expect(db.saveEntries([original, card(second.id, "incoming", { canonicalUrl: original.canonicalUrl, facets: [facet] })])).toBe(1);
    db.markRead(original.id, true); db.markFavorite(original.id, true);
    expect(db.saveEntries([card(second.id, "replay", { canonicalUrl: original.canonicalUrl, title: "Revised", facets: [] })])).toBe(0);
    const retained = db.getEntry(original.id)!;
    expect(retained).toMatchObject({ id: "retained", title: "Revised", read: true, favorite: true });
    expect(retained.origins?.map((origin) => origin.sourceId).sort()).toEqual([first.id, second.id].sort());
    expect(retained.facets).toEqual([]);
    expect(db.getEntry("incoming")).toBeUndefined();
    expect(db.getEntry("replay")).toBeUndefined();
    db.dismissEntry(original.id);
    expect(db.saveEntries([card(second.id, "dismissed-replay", { canonicalUrl: original.canonicalUrl })])).toBe(0);
    expect(db.listEntries()).toEqual([]);
  } finally { db.close(); }
});

it("rolls back earlier inserts and origins when a later record fails", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
    const revision = db.getLibraryRevision();
    expect(() => db.saveEntries([card(source.id, "valid"), card("missing-source", "invalid")])).toThrow(/FOREIGN KEY/);
    expect(db.listEntries()).toEqual([]);
    expect(native(db).prepare("SELECT COUNT(*) AS count FROM entry_origins").get()).toEqual({ count: 0 });
    expect(db.getLibraryRevision()).toBe(revision);
    expect(db.saveEntries([card(source.id, "valid")])).toBe(1);
  } finally { db.close(); }
});
