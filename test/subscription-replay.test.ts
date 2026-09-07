import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { ReadingDatabase } from "../src/main/database";
import { PublicHttpClient } from "../src/main/http";
import { GenericConnector, RssConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SourceService } from "../src/main/source-service";
import { SyncManager } from "../src/main/sync-manager";
import { contentNormalizer } from "../src/main/content-normalizer";
import type { Facet, SyncContext } from "../src/shared/types";

const feedUrl = "https://example.com/feed";
const a = { scheme: "feed:https://example.com:category", key: "a", label: "A" };
const b = { ...a, key: "b", label: "B" };
const scope = (facetSelections: Facet[]) => ({ facetSelections, history: { mode: "none" as const } });
const headers = { etag: '"unchanged"', "last-modified": "Sun, 01 Feb 2026 00:00:00 GMT" };
const feed = `<rss version="2.0"><channel><title>Fixture</title>${[a, b].map((facet) =>
  `<item><title>${facet.label}</title><link>https://example.com/${facet.key}</link><category>${facet.key}</category><pubDate>Sun, 01 Feb 2026 00:00:00 GMT</pubDate></item>`
).join("")}</channel></rss>`;

beforeEach(() => { network.fetch.mockReset(); });

function runtime(db: ReadingDatabase, declaredFeed = false) {
  const registry = new ConnectorRegistry();
  const http = new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
  registry.register(declaredFeed ? new GenericConnector(http) : new RssConnector(http));
  const sync = new SyncManager(db, registry);
  return { sync, service: new SourceService(db, {} as never, sync, {} as never) };
}

describe("replaying a changed collection selection", () => {
  it.each(["etag", "last-modified", "declared-feed"] as const)("recollects newly selected current Feed cards with an unchanged %s response", async (mode) => {
    const db = new ReadingDatabase(":memory:");
    const { sync, service } = runtime(db, mode === "declared-feed");
    const source = db.createSource({ url: feedUrl, title: "Fixture", kind: mode === "declared-feed" ? "generic" : "rss", pollingEnabled: true,
      extractionRule: mode === "declared-feed" ? { version: 1, feedUrl } : undefined });
    const requests: Headers[] = [];
    network.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const request = new Headers(init.headers);
      requests.push(request);
      return request.has("if-none-match") || request.has("if-modified-since")
        ? new Response(null, { status: 304 })
        : new Response(feed, { headers: { "content-type": "application/rss+xml", ...(mode === "last-modified" ? { "last-modified": headers["last-modified"] } : { etag: headers.etag }) } });
    });
    try {
      service.updateCollectionScope(source.id, scope([a]));
      await sync.syncSource(source.id);
      const saved = db.listEntries()[0];
      expect(saved.title).toBe("A");
      db.markFavorite(saved.id, true); db.markRead(saved.id, true);
      await sync.syncSource(source.id);
      expect(requests[1].has(mode === "last-modified" ? "if-modified-since" : "if-none-match")).toBe(true);
      service.updateCollectionScope(source.id, scope([b]));
      await sync.syncSource(source.id);
      expect(db.listEntries(source.id).map((entry) => entry.title)).toEqual(["B"]);
      expect(db.getEntry(saved.id)).toMatchObject({ favorite: true, read: true });
      service.updateCollectionScope(source.id, scope([]));
      await sync.syncSource(source.id);
      expect(db.listEntries(source.id).map((entry) => entry.title).sort()).toEqual(["A", "B"]);
      expect(db.listEntries()).toHaveLength(2);
      expect(requests[2].has("if-none-match") || requests[2].has("if-modified-since")).toBe(false);
    } finally { await sync.close(); db.close(); }
  });

  it("replays a connector checkpoint after categories change, retaining saved cards", async () => {
    const db = new ReadingDatabase(":memory:");
    const registry = new ConnectorRegistry();
    const fetch = vi.fn(async (context: SyncContext) => ({
      entries: context.checkpoint ? [] : [a, b].map((facet) => ({ url: `https://example.com/${facet.key}`, title: facet.label, facets: [facet] })),
      checkpoint: { cursor: "consumed", sinceId: "newest", data: { page: "complete" } }, emptyIsHealthy: true
    }));
    registry.register({ manifest: { id: "rss", version: 1, displayName: "Fixture", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      sync: fetch, normalize: (entry, source) => contentNormalizer.normalize(entry, source) });
    const sync = new SyncManager(db, registry);
    const service = new SourceService(db, {} as never, sync, {} as never);
    const source = db.createSource({ url: feedUrl, title: "Fixture", kind: "rss", pollingEnabled: true });
    try {
      service.updateCollectionScope(source.id, scope([a]));
      await sync.syncSource(source.id);
      service.updateCollectionScope(source.id, scope([a, b]));
      await sync.syncSource(source.id);
      expect(db.listEntries(source.id)).toHaveLength(2);
      expect(fetch.mock.calls[1][0].checkpoint).toBeUndefined();
    } finally { await sync.close(); db.close(); }
  });

  it("retains progress for label/order-only changes and independent history choices", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: feedUrl, title: "Fixture", kind: "rss", pollingEnabled: true });
    try {
      db.updateSubscriptionScope(source.id, scope([a, b]));
      db.markSuccess(source, { etag: headers.etag, validatorUrl: feedUrl });
      db.saveCheckpoint(source.id, { cursor: "preserved" });
      db.updateSubscriptionScope(source.id, { facetSelections: [b, { ...a, label: "Renamed" }, b], history: { mode: "selected", limit: 50 } });
      expect(db.getSource(source.id)).toMatchObject({ etag: headers.etag, validatorUrl: feedUrl });
      expect(db.getCheckpoint(source.id)?.cursor).toBe("preserved");
    } finally { db.close(); }
  });

  it("rolls back the selection and all progress together if invalidation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-rollback-"));
    const path = join(dir, "fixture.sqlite");
    const db = new ReadingDatabase(path);
    const source = db.createSource({ url: feedUrl, title: "Fixture", kind: "rss", pollingEnabled: true });
    try {
      db.updateSubscriptionScope(source.id, scope([a]));
      db.markSuccess(source, { etag: headers.etag, validatorUrl: feedUrl });
      db.saveCheckpoint(source.id, { cursor: "preserved" });
      const observer = new Sqlite(path);
      try { observer.exec("CREATE TRIGGER reject_progress_reset BEFORE DELETE ON sync_checkpoints BEGIN SELECT RAISE(ABORT, 'Synthetic reset failure'); END;"); }
      finally { observer.close(); }
      expect(() => db.updateSubscriptionScope(source.id, scope([b]))).toThrow("Synthetic reset failure");
      expect(db.getSubscriptionForSource(source.id)?.scope).toEqual(scope([a]));
      expect(db.getSource(source.id)).toMatchObject({ etag: headers.etag, validatorUrl: feedUrl });
      expect(db.getCheckpoint(source.id)?.cursor).toBe("preserved");
    } finally { db.close(); rmSync(dir, { recursive: true }); }
  });

  it("retains a required replay after failure and restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-restart-"));
    const path = join(dir, "fixture.sqlite");
    let db = new ReadingDatabase(path);
    let current = runtime(db);
    const source = db.createSource({ url: feedUrl, title: "Fixture", kind: "rss", pollingEnabled: true });
    try {
      current.service.updateCollectionScope(source.id, scope([a]));
      network.fetch.mockResolvedValueOnce(new Response(feed, { headers: { ...headers, "content-type": "application/rss+xml" } }));
      await current.sync.syncSource(source.id);
      current.service.updateCollectionScope(source.id, scope([a, b]));
      network.fetch.mockRejectedValueOnce(new Error("Synthetic offline"));
      await expect(current.sync.syncSource(source.id)).rejects.toThrow();
      expect(db.getSource(source.id)).toMatchObject({ failureCount: 1, etag: undefined, validatorUrl: undefined, lastModified: undefined });
      expect(db.getSource(source.id)!.nextCheckAt).toBeGreaterThan(Date.now());
      await current.sync.close(); db.close(); db = new ReadingDatabase(path); current = runtime(db);
      network.fetch.mockResolvedValueOnce(new Response(feed, { headers: { ...headers, "content-type": "application/rss+xml" } }));
      await current.sync.syncSource(source.id);
      const request = new Headers(network.fetch.mock.lastCall![1].headers);
      expect(request.has("if-none-match") || request.has("if-modified-since")).toBe(false);
      expect(db.listEntries(source.id)).toHaveLength(2);
      expect(db.getSource(source.id)?.failureCount).toBe(0);
    } finally { await current.sync.close(); db.close(); rmSync(dir, { recursive: true }); }
  });
});
