import Sqlite from "better-sqlite3";
import { existsSync } from "node:fs";
import { createReadSnapshot } from "../src/main/persistence/read-snapshot";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import type { Entry } from "../src/shared/types";

function card(sourceId: string, id: string, overrides: Partial<Entry> = {}): Entry {
  return { id, sourceId, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`, title: id,
    contentHash: id, read: false, favorite: false, createdAt: 200, ...overrides };
}
function source(db: ReadingDatabase, path = "feed") {
  return db.createSource({ url: `https://example.com/${path}`, title: path, kind: "rss", pollingEnabled: true });
}

describe("retained library lifecycle", () => {
  it("audits a coherent WAL snapshot without migrating the original database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reading-hub-snapshot-test-"));
    const path = join(dir, "original.sqlite");
    const original = new Sqlite(path);
    let snapshot: Awaited<ReturnType<typeof createReadSnapshot>> | undefined;
    try {
      original.pragma("journal_mode = WAL");
      original.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed WAL');");
      snapshot = await createReadSnapshot(path);
      const copy = new ReadingDatabase(snapshot.path);
      copy.close();
      expect(original.prepare("SELECT name FROM sqlite_master WHERE name = 'subscriptions'").get()).toBeUndefined();
      const inspected = new Sqlite(snapshot.path, { readonly: true });
      expect(inspected.prepare("SELECT value FROM fixture").get()).toEqual({ value: "committed WAL" });
      inspected.close();
      await snapshot.dispose();
      expect(existsSync(snapshot.path)).toBe(false);
    } finally { original.close(); await snapshot?.dispose(); rmSync(dir, { recursive: true }); }
  });

  it("retains saved content and shared origins through unsubscribe, cleanup and restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "reading-hub-retention-"));
    let db = new ReadingDatabase(join(dir, "library.sqlite"));
    try {
      const first = source(db), second = source(db, "second");
      db.saveEntries([card(first.id, "saved", { favorite: true }), card(first.id, "ordinary"), card(first.id, "shared")]);
      db.saveEntries([card(second.id, "other-id", { canonicalUrl: "https://example.com/shared" })]);
      db.markFavorite("saved", true);
      db.setSubscribed(first.id, false);
      expect(db.listDueSources().map((item) => item.id)).not.toContain(first.id);
      expect(db.listEntries({ sourceId: first.id })).toHaveLength(3);
      expect(db.clearSourceContent(first.id)).toBe(1);
      expect(db.listEntries().map((item) => item.id).sort()).toEqual(["saved", "shared"]);
      expect(db.listEntries({ dismissed: true }).map((item) => item.id)).toEqual(["ordinary"]);
      db.close();
      db = new ReadingDatabase(join(dir, "library.sqlite"));
      expect(db.getSource(first.id)?.subscribed).toBe(false);
      expect(db.getEntry("saved")?.favorite).toBe(true);
      expect(db.getEntry("shared")?.origins).toHaveLength(2);
      expect(db.getEntry("ordinary")).toBeUndefined();
      expect(db.saveEntries([card(first.id, "duplicate", { canonicalUrl: "https://example.com/ordinary" })])).toBe(0);
      db.restoreEntry("ordinary");
      expect(db.getEntry("ordinary")?.title).toBe("ordinary");
      const success = db.markSuccess(db.getSource(first.id)!, {});
      expect(success.lastSuccessfulAt).toBeDefined();
      const failure = db.markFailure(success, "offline");
      expect(failure.lastSuccessfulAt).toBe(success.lastSuccessfulAt);
      db.setSubscribed(first.id, true);
      expect(db.listDueSources().map((item) => item.id)).toContain(first.id);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it("preserves favorites and recoverable deletions during recalibration and maintenance", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const first = source(db);
      db.saveEntries([card(first.id, "saved"), card(first.id, "deleted"), card(first.id, "uncertain")]);
      db.markFavorite("saved", true);
      db.dismissEntry("deleted");
      db.updateRule(first.id, { version: 1, itemRootSelector: "article" });
      expect(db.getEntry("saved")?.favorite).toBe(true);
      expect(db.getEntry("uncertain")).toBeUndefined();
      expect(db.listEntries({ dismissed: true }).map((item) => item.id)).toEqual(["deleted"]);
      db.restoreEntry("deleted");
      expect(db.getEntry("deleted")).toBeDefined();
    } finally { db.close(); }
  });

  it("pages by first collection independently of publication and excludes backfill from arrivals", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const first = source(db);
      db.beginLibrarySession(100);
      const items = [
        card(first.id, "a", { publishedAt: 999, createdAt: 110 }),
        card(first.id, "b", { publishedAt: 1, createdAt: 120 }),
        card(first.id, "c", { createdAt: 120 }),
        card(first.id, "history", { ingestionKind: "history", createdAt: 130 })
      ];
      db.saveEntries(items);
      const page = db.listEntryPage({ collection: "current", sort: "collected", pageSize: 2 });
      const next = db.listEntryPage({ collection: "current", sort: "collected", pageSize: 2, cursor: page.nextCursor });
      expect([...page.entries, ...next.entries].map((item) => item.id)).toEqual(["c", "b", "a"]);
      db.saveEntries([card(first.id, "changed", { canonicalUrl: items[0].canonicalUrl, ingestionKind: "history", createdAt: 999 })]);
      expect(db.getEntry("a")).toMatchObject({ createdAt: 110, ingestionKind: "current" });
      expect(db.getLibraryCounts()).toMatchObject({ newArrivals: 3, history: 1 });
      db.dismissEntry("b");
      expect(db.getLibraryCounts()).toMatchObject({ newArrivals: 2, unread: 3 });
      expect(db.listEntries({ publishedOnly: true }).map((item) => item.id)).toEqual(["a"]);
    } finally { db.close(); }
  });

  it("publishes only committed revisions and tolerates disconnected observers", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const first = source(db);
      const listener = vi.fn();
      db.onLibraryChanged(listener);
      db.onLibraryChanged(() => { throw new Error("window closed"); });
      const revision = db.getLibraryRevision();
      expect(() => db.writeTransaction(() => { db.saveEntries([card(first.id, "rollback")]); throw new Error("disk full"); })).toThrow("disk full");
      expect(db.getLibraryRevision()).toBe(revision);
      expect(listener).not.toHaveBeenCalled();
      db.writeTransaction(() => db.saveEntries([card(first.id, "kept")]));
      expect(listener).toHaveBeenCalledTimes(1);
      db.publishChanges();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(db.getEntry("kept")).toBeDefined();
    } finally { db.close(); }
  });
});
