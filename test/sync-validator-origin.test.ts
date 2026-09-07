import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { ReadingDatabase } from "../src/main/database";
import { PublicHttpClient } from "../src/main/http";
import { RssConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { RSS_METADATA_REVISION } from "../src/main/feed";
import { contentNormalizer } from "../src/main/content-normalizer";
const initial = "https://example.com/feed";
const first = "https://example.com/first-feed";
const second = "https://other.example.org/second-feed";
const tag = '"same-but-not-the-same-resource"';
beforeEach(() => { network.fetch.mockReset(); });
function manager(db: ReadingDatabase) {
  const registry = new ConnectorRegistry();
  registry.register(new RssConnector(new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never)));
  return new SyncManager(db, registry);
}

it("upgrades unbound v7 validators and follows changing redirects without losing saved content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "validator-origin-"));
  const path = join(directory, "fixture.sqlite");
  let db = new ReadingDatabase(path);
  let sync: SyncManager | undefined;
  try {
    const source = db.createSource({ url: initial, title: "Fixture", kind: "rss", pollingEnabled: true });
    const entry = contentNormalizer.normalize({ url: "https://content.example.org/current", title: "Saved" }, source);
    db.saveEntries([entry]); db.markFavorite(entry.id, true); db.markRead(entry.id, true);
    db.updateMetadataRevision(source.id, RSS_METADATA_REVISION);
    db.markSuccess(source, { etag: tag, lastModified: "Sun, 01 Feb 2026 00:00:00 GMT" });
    db.close();
    const legacy = new Sqlite(path);
    try {
      legacy.exec("DELETE FROM schema_migrations WHERE version = 8; ALTER TABLE sources DROP COLUMN validator_url;");
    } finally { legacy.close(); }
    db = new ReadingDatabase(path); sync = manager(db);
    expect(db.getSource(source.id)).toMatchObject({ etag: tag, validatorUrl: undefined });
    expect(db.getEntry(entry.id)).toMatchObject({ favorite: true, read: true });
    let destination = first;
    const requests: Array<{ url: string; conditional: string | null }> = [];
    network.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const conditional = new Headers(init.headers).get("if-none-match");
      requests.push({ url, conditional });
      if (url === initial) return new Response(null, { status: 302, headers: { location: destination } });
      if (conditional === tag) return new Response(null, { status: 304 });
      const title = url === first ? "First representation" : "Second representation";
      return new Response(`<rss version="2.0"><channel><title>Fixture</title><item><title>${title}</title><link>https://content.example.org/current</link><pubDate>Sun, 01 Feb 2026 00:00:00 GMT</pubDate></item></channel></rss>`, {
        headers: { "content-type": "application/rss+xml", etag: tag }
      });
    });
    await sync.syncSource(source.id);
    expect(requests.splice(0)).toEqual([{ url: initial, conditional: null }, { url: first, conditional: null }]);
    expect(db.getSource(source.id)).toMatchObject({ validatorUrl: first, etag: tag, lastModified: undefined });
    await sync.syncSource(source.id);
    expect(requests.splice(0)).toEqual([{ url: initial, conditional: null }, { url: first, conditional: tag }]);
    destination = second;
    const record = vi.spyOn(db, "recordSyncEvent").mockImplementationOnce(() => { throw new Error("Synthetic commit failure"); });
    await expect(sync.syncSource(source.id)).rejects.toThrow("Synthetic commit failure");
    record.mockRestore();
    expect(requests.splice(0)).toEqual([{ url: initial, conditional: null }, { url: second, conditional: null }]);
    expect(db.getSource(source.id)).toMatchObject({ validatorUrl: first, etag: tag, failureCount: 1 });
    expect(db.getSource(source.id)?.nextCheckAt).toBeGreaterThan(Date.now());
    expect(db.getEntry(entry.id)?.title).toBe("First representation");
    await sync.syncSource(source.id);
    expect(requests.splice(0)).toEqual([{ url: initial, conditional: null }, { url: second, conditional: null }]);
    expect(db.getEntry(entry.id)).toMatchObject({ title: "Second representation", favorite: true, read: true });
    await sync.close(); db.close(); db = new ReadingDatabase(path); sync = manager(db);
    await sync.syncSource(source.id);
    expect(requests.splice(0)).toEqual([{ url: initial, conditional: null }, { url: second, conditional: tag }]);
    expect(db.listEntries()).toHaveLength(1);
    expect(db.getSource(source.id)?.validatorUrl).toBe(second);
    db.updateRule(source.id, { version: 1 });
    expect(db.getSource(source.id)).toMatchObject({ validatorUrl: undefined, etag: undefined, lastModified: undefined });
    await sync.syncSource(source.id);
    expect(requests.splice(0)).toEqual([{ url: initial, conditional: null }, { url: second, conditional: null }]);
    db.updateSourceSettings(source.id, { title: "Fixture", kind: "generic", pollingEnabled: true });
    expect(db.getSource(source.id)).toMatchObject({ validatorUrl: undefined, etag: undefined, lastModified: undefined });
  } finally { await sync?.close(); db.close(); rmSync(directory, { recursive: true }); }
});
