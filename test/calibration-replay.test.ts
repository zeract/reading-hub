import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { GenericConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SourceService } from "../src/main/source-service";
import { SyncManager } from "../src/main/sync-manager";
import type { TextResponse } from "../src/main/http";

const titles = ["ordinary", "saved", "dismissed"];
const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${titles.map((title) => `<item><title>${title}</title><link>https://example.com/${title}</link><pubDate>Sun, 01 Feb 2026 00:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
const html = `<html><body>${titles.map((title) => `<article><h2><a href="https://example.com/${title}">${title}</a></h2><time datetime="2026-02-01">2026-02-01</time></article>`).join("")}</body></html>`;
function fixture(mode: "feed" | "html", validator: "etag" | "lastModified", path = ":memory:") {
  let db = new ReadingDatabase(path);
  const header = validator === "etag" ? '"fixture-version"' : "Sun, 01 Feb 2026 00:00:00 GMT";
  const getText = vi.fn(async (url: string, cached?: Pick<TextResponse, "etag" | "lastModified">) => ({
    url, status: cached?.[validator] === header ? 304 : 200,
    text: cached?.[validator] === header ? "" : mode === "feed" ? feed : html,
    contentType: mode === "feed" ? "application/rss+xml" : "text/html", [validator]: header
  }));
  const registry = new ConnectorRegistry(); registry.register(new GenericConnector({ getText } as never));
  let sync = new SyncManager(db, registry);
  let service = new SourceService(db, {} as never, sync, {} as never);
  const source = db.createSource({ url: "https://example.com/", title: "Fixture", kind: "generic", pollingEnabled: true,
    extractionRule: mode === "feed" ? { version: 1, feedUrl: "https://example.com/feed.xml" } : { version: 1, itemRootSelector: "article", titleSelector: "h2 a", timeSelector: "time" }
  });
  return {
    get db() { return db; }, get sync() { return sync; }, get service() { return service; }, source, header, getText,
    async reopen() { await sync.close(); db.close(); db = new ReadingDatabase(path); sync = new SyncManager(db, registry); service = new SourceService(db, {} as never, sync, {} as never); },
    async close() { await sync.close(); db.close(); }
  };
}

describe("calibration invalidates collected-response validators", () => {
  it.each((["feed", "html"] as const).flatMap((mode) => (["etag", "lastModified"] as const).map((validator) => [mode, validator] as const)))("reimports unchanged %s content after resetting a %s-validated source", async (mode, validator) => {
    const f = fixture(mode, validator);
    try {
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(3);
      const initial = f.db.listEntries();
      const saved = initial.find((entry) => entry.title === "saved")!;
      const dismissed = initial.find((entry) => entry.title === "dismissed")!;
      f.db.markFavorite(saved.id, true); f.db.dismissEntry(dismissed.id);
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(0);
      expect(f.getText.mock.lastCall?.[1]?.[validator]).toBe(f.header);
      f.service.updateRule(f.source.id, f.db.getSource(f.source.id)!.extractionRule);
      expect(f.db.listEntries().map((entry) => entry.title)).toEqual(["saved"]);
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(1);
      expect(f.db.listEntries().map((entry) => entry.title).sort()).toEqual(["ordinary", "saved"]);
      expect(f.db.getEntry(saved.id)?.favorite).toBe(true);
      expect(f.db.listEntries({ dismissed: true }).map((entry) => entry.id)).toEqual([dismissed.id]);
      f.db.restoreEntry(dismissed.id); expect(f.db.listEntries()).toHaveLength(3);
      expect(f.db.getSource(f.source.id)?.[validator]).toBe(f.header);
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(0);
    } finally { await f.close(); }
  });

  it("keeps the replay requirement across a failed refresh and process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calibration-replay-"));
    const f = fixture("feed", "etag", join(directory, "fixture.sqlite"));
    try {
      await f.sync.syncSource(f.source.id);
      f.service.updateRule(f.source.id, f.db.getSource(f.source.id)!.extractionRule);
      f.getText.mockRejectedValueOnce(new Error("Synthetic offline"));
      await expect(f.sync.syncSource(f.source.id)).rejects.toThrow("Synthetic offline");
      expect(f.db.getSource(f.source.id)).toMatchObject({ status: "error", failureCount: 1 });
      expect(f.db.getSource(f.source.id)?.nextCheckAt).toBeGreaterThan(Date.now());
      await f.reopen();
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(3);
      expect(f.db.getSource(f.source.id)).toMatchObject({ status: "active", failureCount: 0 });
      expect(f.db.listEntries().map((entry) => entry.title).sort()).toEqual([...titles].sort());
    } finally { await f.close(); rmSync(directory, { recursive: true }); }
  });

  it("rolls back validator invalidation and the rule when content removal fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "calibration-rollback-"));
    const path = join(directory, "fixture.sqlite");
    const f = fixture("feed", "etag", path);
    try {
      await f.sync.syncSource(f.source.id);
      const before = f.db.getSource(f.source.id);
      const entries = f.db.listEntries();
      const connection = new Sqlite(path);
      try { connection.exec("CREATE TRIGGER fixture_fail_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'Synthetic delete failure'); END;"); }
      finally { connection.close(); }
      expect(() => f.service.updateRule(f.source.id, { version: 1, feedUrl: "https://example.com/revised.xml" })).toThrow("Synthetic delete failure");
      expect(f.db.getSource(f.source.id)).toEqual(before);
      expect(f.db.listEntries()).toEqual(entries);
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(0);
    } finally { await f.close(); rmSync(directory, { recursive: true }); }
  });
});
