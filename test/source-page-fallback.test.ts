import { expect, it } from "vitest";
import { extractGenericPage } from "../src/main/extractor";
import { ReadingDatabase } from "../src/main/database";
import { GenericConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";

it("does not turn an unhydrated client shell into a source-home article", () => {
  const result = extractGenericPage('<title>Author blog</title><meta property="og:description" content="Long thinking"><body><div id="app"></div><script src="/async.js" async></script></body>', "https://example.com/blog", { version: 1, itemRootSelector: "article", rendererRequired: true });
  expect(result.entries).toEqual([]);
});
it.each(["ordinary", "saved", "shared", "manual"])("replaces only unprotected automatic placeholders (%s)", async mode => {
  const db = new ReadingDatabase(":memory:");
  const source = db.createSource({ url: "https://example.com/blog", title: "Author blog", kind: "generic", pollingEnabled: true });
  if (mode === "manual") db.updateRule(source.id, { version: 1, itemRootSelector: "article", selection: "manual" });
  const entry = { id: "old-page", sourceId: source.id, url: source.url, canonicalUrl: source.url, title: source.title, summary: "Long thinking.", contentHash: "old", read: true, favorite: mode === "saved", createdAt: 1 };
  db.saveEntries([entry]);
  if (mode === "saved") db.markFavorite(entry.id, true);
  if (mode === "shared") {
    const other = db.createSource({ url: "https://example.com/feed", title: "Other", kind: "rss", pollingEnabled: true });
    db.saveEntries([{ ...entry, id: "shared-copy", sourceId: other.id }]);
  }
  const registry = new ConnectorRegistry();
  registry.register(new GenericConnector({ getText: async () => ({ status: 200, url: source.url, contentType: "text/html", text: '<article><h2><a href="/one">One real article</a></h2><time datetime="2026-09-01"></time></article><article><h2><a href="/two">Second real article</a></h2><time datetime="2026-09-02"></time></article>' }) } as never));
  const sync = new SyncManager(db, registry);
  try {
    await sync.syncSource(source.id);
    expect(db.getEntry(entry.id) !== undefined).toBe(mode !== "ordinary");
    expect(db.listEntries(source.id).some(e => e.id === entry.id)).toBe(mode === "saved" || mode === "manual");
    expect((await sync.syncSource(source.id)).inserted).toBe(0);
  } finally { await sync.close(); db.close(); }
});
