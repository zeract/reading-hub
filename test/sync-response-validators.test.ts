import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { PublicHttpClient } from "../src/main/http";
import { ReadingDatabase } from "../src/main/database";
import { GenericConnector, RssConnector } from "../src/main/connectors";
import { XiaohongshuConnector } from "../src/main/xiaohongshu";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";

const oldHeaders = { etag: '"fixture"', "last-modified": "Sun, 01 Feb 2026 00:00:00 GMT" };
const newDate = "Mon, 02 Feb 2026 00:00:00 GMT";
const feed = '<rss version="2.0"><channel><title>Fixture</title><item><title>Current</title><link>https://example.com/current</link><pubDate>Sun, 01 Feb 2026 00:00:00 GMT</pubDate></item></channel></rss>';
const html = '<article><h2><a href="https://example.com/current">Current</a></h2><time datetime="2026-02-01">2026-02-01</time></article>';
const profile = '<script type="application/json" id="SSR_DATA">{"notes":[{"noteId":"note_12345678","title":"Current","user":{"nickname":"Fixture author"}}]}</script>';
type Mode = "rss" | "html" | "declared-feed" | "xiaohongshu";
function fixture(mode: Mode, path = ":memory:") {
  const db = new ReadingDatabase(path);
  const http = new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
  const registry = new ConnectorRegistry();
  registry.register(mode === "rss" ? new RssConnector(http) : mode === "xiaohongshu" ? new XiaohongshuConnector(http) : new GenericConnector(http));
  const sync = new SyncManager(db, registry);
  const source = db.createSource({ url: mode === "xiaohongshu" ? "https://www.xiaohongshu.com/user/profile/fixture_1234" : "https://example.com/source", title: "Fixture", kind: mode === "rss" || mode === "xiaohongshu" ? mode : "generic", pollingEnabled: true,
    extractionRule: mode === "declared-feed" ? { version: 1, feedUrl: "https://example.com/feed" } : undefined,
    config: { archiveCatalog: { url: "https://example.com/archive" } }
  });
  const full = (headers: Record<string, string> = oldHeaders) => new Response(mode === "html" ? html : mode === "xiaohongshu" ? profile : feed, {
    headers: { "content-type": mode === "html" || mode === "xiaohongshu" ? "text/html" : "application/rss+xml", ...headers }
  });
  return { db, sync, source, full, close: async () => { await sync.close(); db.close(); } };
}
beforeEach(() => { network.fetch.mockReset(); });

describe("HTTP response validator persistence", () => {
  it.each(["rss", "html", "declared-feed", "xiaohongshu"] as const)("replaces missing validators after a complete %s response", async (mode) => {
    const f = fixture(mode);
    try {
      network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
      network.fetch.mockResolvedValueOnce(f.full({ etag: '"next"' })); await f.sync.syncSource(f.source.id);
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: '"next"', lastModified: undefined });
      network.fetch.mockResolvedValueOnce(f.full({})); await f.sync.syncSource(f.source.id);
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: undefined, lastModified: undefined });
      network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
      const request = network.fetch.mock.lastCall![1] as RequestInit;
      expect(new Headers(request.headers).has("if-none-match")).toBe(false);
      expect(new Headers(request.headers).has("if-modified-since")).toBe(false);
      expect(f.db.listEntries()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["rss", "html", "declared-feed", "xiaohongshu"] as const)("merges provided 304 metadata and preserves omitted %s validators", async (mode) => {
    const f = fixture(mode);
    try {
      network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
      network.fetch.mockResolvedValueOnce(new Response(null, { status: 304, headers: { "last-modified": newDate } }));
      await f.sync.syncSource(f.source.id);
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: oldHeaders.etag, lastModified: newDate });
      network.fetch.mockResolvedValueOnce(new Response(null, { status: 304 })); await f.sync.syncSource(f.source.id);
      const request = new Headers((network.fetch.mock.lastCall![1] as RequestInit).headers);
      expect(request.get("if-none-match")).toBe(oldHeaders.etag);
      expect(request.get("if-modified-since")).toBe(newDate);
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: oldHeaders.etag, lastModified: newDate });
      expect(f.db.listEntries()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("preserves Feed validators without backfilling legacy history scopes on a 304", async () => {
    const f = fixture("rss");
    try {
      network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
      f.db.updateSubscriptionScope(f.source.id, { facetSelections: [], history: { mode: "all" } });
      network.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
      expect((await f.sync.syncSource(f.source.id)).inserted).toBe(0);
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: oldHeaders.etag, lastModified: oldHeaders["last-modified"] });
      expect(f.db.listEntries()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not commit replacement validators if the content transaction fails", async () => {
    const f = fixture("rss");
    try {
      network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
      network.fetch.mockResolvedValueOnce(f.full({}));
      const record = vi.spyOn(f.db, "recordSyncEvent").mockImplementationOnce(() => { throw new Error("Synthetic commit failure"); });
      await expect(f.sync.syncSource(f.source.id)).rejects.toThrow("Synthetic commit failure"); record.mockRestore();
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: oldHeaders.etag, lastModified: oldHeaders["last-modified"], failureCount: 1 });
      network.fetch.mockResolvedValueOnce(f.full({})); await f.sync.syncSource(f.source.id);
      expect(f.db.getSource(f.source.id)).toMatchObject({ etag: undefined, lastModified: undefined, failureCount: 0 });
    } finally { await f.close(); }
  });
});


it("clears HTTP validators when a source deliberately uses rendered HTML", async () => {
  const db = new ReadingDatabase(":memory:");
  const http = new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
  const registry = new ConnectorRegistry();
  const render = vi.fn(async (url: string) => ({ url, html }));
  registry.register(new GenericConnector(http, { render } as never));
  const sync = new SyncManager(db, registry);
  try {
    const source = db.createSource({ url: "https://example.com/rendered", title: "Fixture", kind: "generic", pollingEnabled: true,
      extractionRule: { version: 1, rendererRequired: true } });
    db.markSuccess(source, { etag: oldHeaders.etag, lastModified: oldHeaders["last-modified"] });
    // Date enrichment may issue a separate metadata read; it has no validators.
    network.fetch.mockResolvedValueOnce(new Response(html, { headers: { "content-type": "text/html" } }));
    await sync.syncSource(source.id);
    expect(render).toHaveBeenCalledTimes(1);
    for (const [, init] of network.fetch.mock.calls) {
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.has("if-none-match")).toBe(false);
      expect(headers.has("if-modified-since")).toBe(false);
    }
    expect(db.getSource(source.id)).toMatchObject({ etag: undefined, lastModified: undefined });
    expect(db.listEntries()).toHaveLength(1);
  } finally { await sync.close(); db.close(); }
});

it("keeps existing validators when a non-HTTP result does not update them", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const source = db.createSource({ url: "https://example.com/source", title: "Fixture", kind: "generic", pollingEnabled: true });
    db.markSuccess(source, { etag: oldHeaders.etag, lastModified: oldHeaders["last-modified"] });
    db.markSuccess(db.getSource(source.id)!, {});
    expect(db.getSource(source.id)).toMatchObject({ etag: oldHeaders.etag, lastModified: oldHeaders["last-modified"] });
  } finally { db.close(); }
});


it("does not transfer a homepage validator to a newly discovered Feed without validators", async () => {
  const f = fixture("html");
  try {
    network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
    network.fetch.mockResolvedValueOnce(new Response('<link rel="alternate" type="application/rss+xml" href="/feed.xml">' + html, {
      headers: { "content-type": "text/html", etag: '"homepage"' }
    }));
    network.fetch.mockResolvedValueOnce(new Response(feed, { headers: { "content-type": "application/rss+xml" } }));
    await f.sync.syncSource(f.source.id);
    expect(f.db.getSource(f.source.id)).toMatchObject({ extractionRule: { feedUrl: "https://example.com/feed.xml" }, etag: undefined, lastModified: undefined });
    network.fetch.mockResolvedValueOnce(new Response(feed, { headers: { "content-type": "application/rss+xml" } }));
    await f.sync.syncSource(f.source.id);
    expect(network.fetch.mock.lastCall![0]).toBe("https://example.com/feed.xml");
    const headers = new Headers((network.fetch.mock.lastCall![1] as RequestInit).headers);
    expect(headers.has("if-none-match")).toBe(false);
    expect(headers.has("if-modified-since")).toBe(false);
  } finally { await f.close(); }
});

it("persists removal of validators across reopening the local database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "response-validators-"));
  const path = join(directory, "fixture.sqlite");
  const f = fixture("rss", path);
  try {
    try {
      network.fetch.mockResolvedValueOnce(f.full()); await f.sync.syncSource(f.source.id);
      network.fetch.mockResolvedValueOnce(f.full({})); await f.sync.syncSource(f.source.id);
    } finally { await f.close(); }
    const reopened = new ReadingDatabase(path);
    try {
      expect(reopened.getSource(f.source.id)).toMatchObject({ etag: undefined, lastModified: undefined });
      expect(reopened.listEntries()).toHaveLength(1);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true }); }
});
