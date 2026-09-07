import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import type { ProbeResult, SourceKind } from "../src/shared/types";

function fixture(db: ReadingDatabase, kind: SourceKind = "rss") {
  const sync = { requestDueRun: vi.fn(), cancelSource: vi.fn(), savePreview: vi.fn(), syncSource: vi.fn().mockResolvedValue(undefined) };
  const probe = { probe: vi.fn(async (url: string): Promise<ProbeResult> => ({
    url, kind, title: "Detected title", confidence: 1, requiresReview: false, preview: []
  })) };
  const service = new SourceService(db, probe as never, sync as never, undefined as never);
  return { service, sync, confirm: async (url: string) => service.confirm((await service.preview(url)).token) };
}

function opml(...urls: string[]) {
  return `<opml><body>${urls.map((url) => `<outline xmlUrl="${url.replaceAll("&", "&amp;")}" />`).join("")}</body></opml>`;
}

describe("subscription URL identity across addition paths", () => {
  it.each([
    ["https://example.com/feed", "https://example.com/feed/"],
    ["https://example.com/feed?utm_source=one", "https://example.com/feed?utm_source=two"],
    ["https://example.com/feed?source=one", "https://example.com/feed?source=two"],
    ["https://example.com/feed?category=one", "https://example.com/feed?category=two"]
  ])("preserves distinct requested resources: %s and %s", async (first, second) => {
    const db = new ReadingDatabase(":memory:");
    const { service, confirm } = fixture(db);
    try {
      const existing = await confirm(first);
      expect(service.importOpml(opml(first, second))).toEqual({ imported: 1, existing: 1, skipped: 0 });
      expect(db.listSources().map((source) => source.url).sort()).toEqual([first, second].sort());
      expect((await confirm(second)).id).not.toBe(existing.id);
      expect(db.listSources()).toHaveLength(2);
    } finally { db.close(); }
  });

  it("uses the same identity for two confirmations and an OPML import", async () => {
    const db = new ReadingDatabase(":memory:");
    const { service, confirm, sync } = fixture(db);
    try {
      const [first, second] = await Promise.all([
        confirm("https://example.com/feed#one"), confirm("https://example.com/feed#two")
      ]);
      expect(second.id).toBe(first.id);
      expect(service.importOpml(opml("https://EXAMPLE.com:443/feed#three"))).toEqual({ imported: 0, existing: 1, skipped: 0 });
      expect(db.listSources()).toHaveLength(1);
      expect(sync.syncSource).toHaveBeenCalledTimes(1);
      expect(sync.savePreview).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("restores an imported subscription after restart without replacing its settings or collected state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-source-identity-"));
    const file = join(directory, "library.sqlite");
    let db = new ReadingDatabase(file);
    try {
      fixture(db).service.importOpml(opml("https://example.com/feed#old"));
      const source = db.listSources()[0];
      db.updateSourceSettings(source.id, { title: "My title", category: "My folder", kind: "rss", pollingEnabled: true, refreshIntervalMinutes: 240 });
      db.saveEntries([{ id: "saved", sourceId: source.id, url: "https://example.com/article", canonicalUrl: "https://example.com/article",
        title: "Saved article", publishedAt: 10, createdAt: 20, contentHash: "fixture", read: false, favorite: false }]);
      db.markRead("saved", true); db.markFavorite("saved", true);
      db.setSubscribed(source.id, false);
      db.close(); db = new ReadingDatabase(file);
      const { confirm, sync } = fixture(db);
      expect(await confirm("https://example.com/feed#new")).toMatchObject({
        id: source.id, subscribed: true, title: "My title", category: "My folder", refreshIntervalMinutes: 240
      });
      expect(db.listSources()).toHaveLength(1);
      expect(db.getEntry("saved")).toMatchObject({ sourceId: source.id, read: true, favorite: true, publishedAt: 10, createdAt: 20 });
      expect(sync.savePreview).not.toHaveBeenCalled();
      expect(sync.syncSource).not.toHaveBeenCalled();
      expect(sync.cancelSource).toHaveBeenCalledExactlyOnceWith(source.id);
    } finally { db.close(); rmSync(directory, { recursive: true }); }
  });

  it("prefers an exact legacy match without merging or deleting older duplicate sources", async () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const first = db.createSource({ url: "https://example.com/feed#one", title: "First", kind: "rss", pollingEnabled: true });
      db.createSource({ url: "https://example.com/feed#two", title: "Second", kind: "rss", pollingEnabled: true });
      expect((await fixture(db).confirm(first.url)).id).toBe(first.id);
      expect(db.listSources()).toHaveLength(2);
    } finally { db.close(); }
  });

  it.each(["generic", "manual"] as const)("preserves fragment navigation for %s sources", async (kind) => {
    const db = new ReadingDatabase(":memory:");
    try {
      const { confirm } = fixture(db, kind);
      const first = await confirm("https://example.com/#/one");
      const second = await confirm("https://example.com/#/two");
      expect(first.id).not.toBe(second.id);
      expect((await confirm(first.url)).id).toBe(first.id);
      expect(db.listSources()).toHaveLength(2);
    } finally { db.close(); }
  });
});
