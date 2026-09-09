import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import type { Entry } from "../src/shared/types";

const today = new Date(2026, 8, 8, 12).getTime();
const tomorrow = new Date(2026, 8, 9, 12).getTime();
const native = (db: ReadingDatabase) => (db as unknown as { db: Sqlite.Database }).db;
const source = (db: ReadingDatabase) => db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
const card = (sourceId: string, id: string, overrides: Partial<Entry> = {}): Entry => ({
  id, sourceId, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`,
  title: "Fixture", createdAt: today, publishedAt: today, read: false, favorite: false, contentHash: "fixture", providerId: "rss", ...overrides
});

/** Count executions of the real aggregate statement, not just its preparation. */
function traceCounts(db: ReadingDatabase) {
  let executions = 0;
  const raw = native(db);
  const prepare = raw.prepare.bind(raw);
  vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("AS new_arrivals")) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...parameters: unknown[]) => { executions++; return get(...parameters); });
    }
    return statement;
  });
  return () => executions;
}

afterEach(() => vi.restoreAllMocks());

describe("committed library count reuse", () => {
  it("scans a 5000-card library once across repeated unchanged reads and protects the cached value from callers", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const id = source(db).id;
      db.saveEntries(Array.from({ length: 5_000 }, (_, index) => card(id, `entry-${index}`, { ingestionKind: index % 2 ? "history" : "current" })));
      const scans = traceCounts(db);
      for (let index = 0; index < 25; index++) {
        const counts = db.getLibraryCounts(today + index);
        expect(counts).toMatchObject({ collected: 2_500, history: 2_500, unread: 5_000, favorite: 0, today: 5_000 });
        counts.unread = -1;
      }
      expect(scans()).toBe(1);
    } finally { db.close(); }
  });

  it("invalidates empty and populated snapshots after committed writes", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const id = source(db).id;
      const scans = traceCounts(db);
      expect(db.getLibraryCounts(today)).toMatchObject({ unread: 0, favorite: 0, today: 0 });
      expect(db.getLibraryCounts(today).unread).toBe(0);
      db.saveEntries([card(id, "current"), card(id, "history", { ingestionKind: "history", createdAt: tomorrow, publishedAt: tomorrow })]);
      expect(db.getLibraryCounts(today)).toMatchObject({ collected: 1, history: 1, unread: 2, today: 1 });
      db.markRead("current", true);
      expect(db.getLibraryCounts(today).unread).toBe(1);
      db.markFavorite("current", true);
      expect(db.getLibraryCounts(today).favorite).toBe(1);
      db.dismissEntry("current");
      expect(db.getLibraryCounts(today)).toMatchObject({ collected: 0, unread: 1, favorite: 0, today: 0 });
      db.restoreEntry("current");
      expect(db.getLibraryCounts(today)).toMatchObject({ collected: 1, unread: 1, favorite: 1, today: 1 });
      expect(scans()).toBe(6);
    } finally { db.close(); }
  });

  it("recomputes local-day boundaries in both directions without any database write", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const id = source(db).id;
      db.saveEntries([card(id, "today"), card(id, "tomorrow-a", { createdAt: tomorrow, publishedAt: tomorrow }), card(id, "tomorrow-b", { createdAt: tomorrow, publishedAt: tomorrow })]);
      const scans = traceCounts(db);
      expect(db.getLibraryCounts(today).today).toBe(1);
      expect(db.getLibraryCounts(today + 1).today).toBe(1);
      expect(db.getLibraryCounts(tomorrow).today).toBe(2);
      expect(db.getLibraryCounts(today).today).toBe(1);
      expect(scans()).toBe(3);
    } finally { db.close(); }
  });

  it("includes the visit baseline even when the library revision stays unchanged", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      db.beginLibrarySession(100);
      const id = source(db).id;
      db.saveEntries([card(id, "between", { createdAt: 150 })]);
      const revision = db.getLibraryRevision();
      expect(db.getLibraryCounts(today).newArrivals).toBe(1);
      db.beginLibrarySession(200);
      expect(db.getLibraryCounts(today).newArrivals).toBe(1);
      db.beginLibrarySession(300);
      expect(db.getLibraryRevision()).toBe(revision);
      expect(db.getLibraryCounts(today).newArrivals).toBe(0);
    } finally { db.close(); }
  });

  it("reads transaction-local changes without caching them or contaminating a rolled-back revision", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const id = source(db).id;
      db.saveEntries([card(id, "entry")]);
      expect(db.getLibraryCounts(today)).toMatchObject({ unread: 1, favorite: 0 });
      expect(() => db.writeTransaction(() => {
        db.markRead("entry", true);
        expect(db.getLibraryCounts(today)).toMatchObject({ unread: 0, favorite: 0 });
        throw new Error("Synthetic rollback");
      })).toThrow("Synthetic rollback");
      expect(db.getLibraryCounts(today)).toMatchObject({ unread: 1, favorite: 0 });
      // The same numerical revision can now represent a different committed write.
      db.markFavorite("entry", true);
      expect(db.getLibraryCounts(today)).toMatchObject({ unread: 1, favorite: 1 });
      db.writeTransaction(() => {
        db.markRead("entry", true);
        expect(db.getLibraryCounts(today).unread).toBe(0);
      });
      expect(db.getLibraryCounts(today)).toMatchObject({ unread: 0, favorite: 1 });
    } finally { db.close(); }
  });

  it("detects commits from another connection and recomputes after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-count-cache-"));
    const file = join(directory, "library.sqlite");
    let db = new ReadingDatabase(file);
    const other = new ReadingDatabase(file);
    try {
      const id = source(db).id;
      db.saveEntries([card(id, "entry")]);
      expect(db.getLibraryCounts(today).favorite).toBe(0);
      other.markFavorite("entry", true);
      expect(db.getLibraryCounts(today).favorite).toBe(1);
      db.close();
      expect(() => db.getLibraryCounts(today)).toThrow(/not open/);
      db = new ReadingDatabase(file);
      expect(db.getLibraryCounts(today)).toMatchObject({ collected: 1, favorite: 1, today: 1 });
    } finally { db.close(); other.close(); rmSync(directory, { recursive: true }); }
  });

  it("propagates a failed aggregate without acknowledging its revision or preventing retry", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const id = source(db).id;
      expect(db.getLibraryCounts(today).unread).toBe(0);
      db.saveEntries([card(id, "entry")]);
      const raw = native(db);
      const prepare = raw.prepare.bind(raw);
      const failure = new Error("Synthetic count read failure");
      let fail = true;
      vi.spyOn(raw, "prepare").mockImplementation((sql: string) => {
        if (fail && sql.includes("AS new_arrivals")) { fail = false; throw failure; }
        return prepare(sql);
      });
      expect(() => db.getLibraryCounts(today)).toThrow(failure);
      expect(db.getLibraryCounts(today).unread).toBe(1);
      expect(db.getLibraryCounts(today).unread).toBe(1);
    } finally { db.close(); }
  });
});
