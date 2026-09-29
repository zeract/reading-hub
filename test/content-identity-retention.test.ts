import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { ContentMaintenance } from "../src/main/content-maintenance";
import type { Entry } from "../src/shared/types";

function card(sourceId: string, id: string, url: string, extra: Partial<Entry> = {}): Entry {
  return { id, sourceId, url, canonicalUrl: url, title: id, contentHash: id, read: false, favorite: false, createdAt: 1, ...extra };
}

describe("content identity retention", () => {
  it("attaches a second reading URL to one unambiguous stable content identity without losing user state", () => {
    const dir = mkdtempSync(join(tmpdir(), "reading-hub-stable-identity-"));
    const path = join(dir, "library.sqlite");
    let db = new ReadingDatabase(path);
    try {
      const first = db.createSource({ url: "https://example.com/feed", title: "First", kind: "rss", pollingEnabled: true });
      const second = db.createSource({ url: "https://elsewhere.example/feed", title: "Second", kind: "rss", pollingEnabled: true });
      const identity = "doi:10.1000/shared";
      const original = card(first.id, "retained", "https://publisher.example/paper", { canonicalIdentity: identity });
      expect(db.saveEntries([original])).toBe(1);
      db.markRead(original.id, true);
      db.markFavorite(original.id, true);
      expect(db.saveEntries([card(second.id, "incoming", "https://archive.example/paper", { canonicalIdentity: identity, title: "Updated metadata" })])).toBe(0);
      const retained = db.getEntry(original.id)!;
      expect(retained).toMatchObject({ id: original.id, canonicalUrl: original.canonicalUrl, title: "Updated metadata", read: true, favorite: true });
      expect(retained.origins?.map((origin) => origin.sourceId).sort()).toEqual([first.id, second.id].sort());
      expect(db.listEntries(second.id).map((entry) => entry.id)).toEqual([original.id]);
      db.close();
      db = new ReadingDatabase(path);
      expect(db.getEntry(original.id)).toMatchObject({ read: true, favorite: true });
      expect(db.listEntries(second.id).map((entry) => entry.id)).toEqual([original.id]);
      db.dismissEntry(original.id);
      expect(db.saveEntries([card(second.id, "third", "https://third.example/paper", { canonicalIdentity: identity })])).toBe(0);
      expect(db.listEntries()).toEqual([]);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it("does not choose an arbitrary row when legacy content already has a conflicting stable ID", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
      db.saveEntries([
        card(source.id, "first", "https://example.com/one", { canonicalIdentity: "doi:10.1000/shared" }),
        card(source.id, "second", "https://example.com/two", { canonicalIdentity: "doi:10.1000/other" })
      ]);
      const raw = (db as unknown as { db: Sqlite.Database }).db;
      raw.prepare("UPDATE entries SET canonical_identity = ? WHERE id = ?").run("doi:10.1000/shared", "second");
      expect(db.saveEntries([card(source.id, "incoming", "https://example.com/three", { canonicalIdentity: "doi:10.1000/shared" })])).toBe(1);
      expect(db.listEntries().map((entry) => entry.id).sort()).toEqual(["first", "incoming", "second"]);
    } finally { db.close(); }
  });

  it("does not merge different URLs merely because their displayed metadata match", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
      expect(db.saveEntries([
        card(source.id, "one", "https://example.com/one", { title: "Same title" }),
        card(source.id, "two", "https://example.com/two", { title: "Same title" })
      ])).toBe(2);
    } finally { db.close(); }
  });

  it("does not revive a dismissed URL when a provider supplies a different content identity", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
      const item = card(source.id, "original", "https://example.com/article");
      db.saveEntries([item]); db.dismissEntry(item.id);
      db.saveEntries([{ ...item, id: "incoming", canonicalIdentity: "provider:article", title: "Changed" }]);
      expect(db.listEntries()).toEqual([]);
      expect(db.listEntries({ dismissed: true })).toMatchObject([{ id: "original", title: "original" }]);
      db.restoreEntry(item.id);
      expect(db.getEntry(item.id)).toBeDefined();
    } finally { db.close(); }
  });

  it("preserves deletion, first collection category and source facets through canonical merging and restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "reading-hub-identity-"));
    const path = join(dir, "library.sqlite");
    let db = new ReadingDatabase(path);
    try {
      const source = db.createSource({ url: "https://scour.ing/feed", title: "Feed", kind: "rss", pollingEnabled: true });
      const base = "https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost";
      const older = card(source.id, "older", `${base}?as=one`, { canonicalIdentity: `${base}?as=one`, ingestionKind: "history", createdAt: 10, observedAt: 10, facets: [{ scheme: "test", key: "old", label: "Old" }] });
      const newer = card(source.id, "newer", base, { ingestionKind: "current", createdAt: 1_000_000_000, observedAt: 1_000_000_000, facets: [{ scheme: "test", key: "new", label: "New" }] });
      db.saveEntries([older, newer]); db.markFavorite(newer.id, true); db.dismissEntry(older.id);
      expect(db.repairScourRedirectEntries(source.id)).toBe(1);
      expect(db.listEntries()).toEqual([]);
      expect(db.listEntries({ dismissed: true })).toMatchObject([{ canonicalUrl: base, createdAt: 10, observedAt: 10, ingestionKind: "history", favorite: true }]);
      const merged = db.listEntries({ dismissed: true })[0];
      expect(merged.facets?.map((facet) => facet.key).sort()).toEqual(["new", "old"]);
      db.close(); db = new ReadingDatabase(path);
      expect(db.getEntry(merged.id)).toBeUndefined();
      db.restoreEntry(merged.id);
      expect(db.listEntries({ collection: "history" })).toHaveLength(1);
      db.dismissEntry(merged.id); db.restoreEntry(merged.id);
      expect(db.listEntries()).toHaveLength(1);
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it("upgrades v6 orphan tombstones even after an older repair was marked complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "reading-hub-identity-migration-"));
    const path = join(dir, "library.sqlite");
    let db = new ReadingDatabase(path);
    try {
      const source = db.createSource({ url: "https://scour.ing/feed", title: "Feed", kind: "rss", pollingEnabled: true });
      const base = "https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost";
      db.saveEntries([card(source.id, "surviving", base)]);
      db.markSourceMaintenanceRevision(source.id, 1);
      db.close();
      const legacy = new Sqlite(path);
      try {
        legacy.prepare("INSERT INTO dismissed_contents VALUES (?, ?)").run(`${base}?as=old`, 123);
        legacy.prepare("INSERT INTO dismissed_contents VALUES (?, ?)").run("provider:unrelated", 456);
        legacy.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
      } finally { legacy.close(); }
      db = new ReadingDatabase(path);
      expect(db.listEntries()).toEqual([]);
      expect(db.listEntries({ dismissed: true }).map((item) => item.id)).toEqual(["surviving"]);
      db.restoreEntry("surviving");
      db.close(); db = new ReadingDatabase(path);
      expect(db.listEntries()).toHaveLength(1);
      const verified = new Sqlite(path, { readonly: true });
      try { expect(verified.prepare("SELECT * FROM dismissed_contents").all()).toEqual([{ canonical_identity: "provider:unrelated", dismissed_at: 456 }]); }
      finally { verified.close(); }
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it("keeps a generic homepage correction deleted when its annotated URL is normalized", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/", title: "Generic", kind: "generic", pollingEnabled: true });
      db.saveEntries([card(source.id, "corrected", "https://example.com/?legacy=1", { canonicalIdentity: "https://example.com/article?utm_source=feed" })]);
      db.dismissEntry("corrected");
      expect(db.repairGenericHomepageEntryUrls(source)).toBe(1);
      expect(db.listEntries()).toEqual([]);
      db.restoreEntry("corrected");
      expect(db.getEntry("corrected")?.canonicalUrl).toBe("https://example.com/article");
    } finally { db.close(); }
  });

  it("keeps the saved card identity when a much newer unsaved duplicate is merged", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://scour.ing/feed", title: "Feed", kind: "rss", pollingEnabled: true });
      const base = "https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost";
      db.saveEntries([card(source.id, "saved", `${base}?as=old`, { createdAt: 1 }), card(source.id, "recent", base, { createdAt: 1_000_000_000 })]);
      db.markFavorite("saved", true);
      db.repairScourRedirectEntries(source.id);
      expect(db.getEntry("saved")).toMatchObject({ canonicalUrl: base, favorite: true });
      expect(db.getEntry("recent")).toBeUndefined();
    } finally { db.close(); }
  });

  it("does not claim an unavailable card was restored", () => {
    const db = new ReadingDatabase(":memory:");
    try { expect(() => db.restoreEntry("missing")).toThrow("最近删除"); }
    finally { db.close(); }
  });

  it("rolls back a complete startup maintenance pass when its last step fails", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/", title: "Feed", kind: "generic", pollingEnabled: true });
      db.saveEntries([card(source.id, "taxonomy", "https://example.com/tags/test")]);
      vi.spyOn(db, "markSourceMaintenanceRevision").mockImplementationOnce(() => { throw new Error("disk full"); });
      const report = new ContentMaintenance(db).runStartupMaintenance();
      expect(report.maintainedSources).toBe(0);
      expect(report.taxonomyEntriesRemoved).toBe(0);
      expect(report.failures).toHaveLength(1);
      expect(db.getEntry("taxonomy")).toBeDefined();
      expect(db.getSourceMaintenanceRevision(source.id)).toBeUndefined();
      expect(new ContentMaintenance(db).runStartupMaintenance().maintainedSources).toBe(1);
    } finally { db.close(); }
  });
});
