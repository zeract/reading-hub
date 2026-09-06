import { describe, expect, it, vi } from "vitest";
import { inspectPublicArchiveFacets } from "../src/main/archive-backfill";
import { RssConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

const archiveUrl = "https://example.com/archive.html";
const archive = '<ul><li><time datetime="2026-08-01">2026-08-01</time><a href="/post">Fixture post</a><a rel="tag" href="/tags/ml">Machine Learning</a></li></ul>';
const response = () => ({ url: archiveUrl, status: 200, contentType: "text/html", text: archive });

function setup(getText: (...args: any[]) => Promise<unknown>, hasArchive = true) {
  const database = new ReadingDatabase(":memory:");
  const source = database.createSource({
    url: "https://example.com/feed.xml", kind: "rss", title: "Fixture", pollingEnabled: true,
    config: hasArchive ? { archiveCatalog: { url: archiveUrl } } : {}
  });
  const http = { getText: vi.fn(getText) };
  const rss = new RssConnector(http as any);
  const connectors = new ConnectorRegistry();
  connectors.register(rss);
  const sync = { syncSource: vi.fn(), savePreview: vi.fn() };
  const service = new SourceService(database, {} as any, sync as any, {} as any, connectors);
  return { database, source, http, rss, service, sync };
}

describe("collection catalogue cancellation", () => {
  it.each(["archive", "connector", "service"] as const)("rejects a cancelled %s inspection before requesting data", async (layer) => {
    const run = setup(async () => response());
    const controller = new AbortController();
    controller.abort(new Error("cancel catalogue"));
    try {
      const pending = layer === "archive"
        ? inspectPublicArchiveFacets(run.http as any, archiveUrl, controller.signal)
        : layer === "connector"
          ? run.rss.inspectFacets(run.source, { signal: controller.signal })
          : run.service.inspectCollectionFacets(run.source.id, controller.signal);
      await expect(pending).rejects.toThrow("cancel catalogue");
      expect(run.http.getText).not.toHaveBeenCalled();
    } finally { run.database.close(); }
  });

  it("does not parse a response returned after cancellation", async () => {
    const controller = new AbortController();
    const readText = vi.fn(() => archive);
    const run = setup(async () => {
      controller.abort(new Error("cancel catalogue"));
      return { ...response(), get text() { return readText(); } };
    });
    try {
      await expect(run.service.inspectCollectionFacets(run.source.id, controller.signal)).rejects.toThrow("cancel catalogue");
      expect(readText).not.toHaveBeenCalled();
    } finally { run.database.close(); }
  });

  it("cancels an in-flight archive download and permits a read-only retry", async () => {
    let signal!: AbortSignal;
    const run = setup(async (_url, _cache, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const subscription = run.database.getSubscriptionForSource(run.source.id)!;
    const checkpoint = run.database.getCheckpoint(subscription.id);
    const revision = run.database.getLibraryRevision();
    try {
      const pending = run.service.inspectCollectionFacets(run.source.id, controller.signal);
      const rejected = expect(pending).rejects.toThrow("cancel catalogue");
      expect(signal).toBe(controller.signal);
      controller.abort(new Error("cancel catalogue"));
      await rejected;
      run.http.getText.mockResolvedValue(response());
      const facets = await run.service.inspectCollectionFacets(run.source.id);
      expect(facets).toEqual([{ sourceId: run.source.id, entryCount: 0, scheme: "feed:https://example.com:tag", key: "ml", label: "Machine Learning" }]);
      expect(run.database.listEntries(run.source.id)).toEqual([]);
      expect(run.database.getSubscriptionForSource(run.source.id)).toEqual(subscription);
      expect(run.database.getCheckpoint(subscription.id)).toEqual(checkpoint);
      expect(run.database.getLibraryRevision()).toBe(revision);
      expect(run.sync.syncSource).not.toHaveBeenCalled();
      expect(run.sync.savePreview).not.toHaveBeenCalled();
    } finally { run.database.close(); }
  });

  it.each([undefined, { facets: [], totalEntries: 0 }])("rejects late adapter results before returning local facets (%j)", async (result) => {
    const run = setup(async () => response());
    const controller = new AbortController();
    vi.spyOn(run.rss, "inspectFacets").mockImplementationOnce(async () => {
      controller.abort(new Error("cancel catalogue"));
      return result as any;
    });
    try {
      await expect(run.service.inspectCollectionFacets(run.source.id, controller.signal)).rejects.toThrow("cancel catalogue");
    } finally { run.database.close(); }
  });

  it("keeps local facet counts when the source has no declared archive", async () => {
    const run = setup(async () => response(), false);
    run.database.saveEntries([run.rss.normalize({
      url: "https://example.com/post", title: "Local post", publishedAt: 1,
      facets: [{ scheme: "feed:https://example.com:tag", key: "ml", label: "Machine Learning" }]
    }, run.source)]);
    try {
      await expect(run.service.inspectCollectionFacets(run.source.id)).resolves.toEqual([
        { sourceId: run.source.id, entryCount: 1, scheme: "feed:https://example.com:tag", key: "ml", label: "Machine Learning" }
      ]);
      expect(run.http.getText).not.toHaveBeenCalled();
      const controller = new AbortController();
      controller.abort(new Error("cancel catalogue"));
      await expect(run.service.inspectCollectionFacets(run.source.id, controller.signal)).rejects.toThrow("cancel catalogue");
    } finally { run.database.close(); }
  });

  it("preserves normal network errors and public archive URL validation", async () => {
    const failure = new Error("Archive temporarily unavailable");
    const run = setup(async () => { throw failure; });
    try {
      await expect(run.service.inspectCollectionFacets(run.source.id)).rejects.toBe(failure);
      run.http.getText.mockClear();
      await expect(inspectPublicArchiveFacets(run.http as any, "https://127.0.0.1/archive.html")).rejects.toThrow();
      expect(run.http.getText).not.toHaveBeenCalled();
    } finally { run.database.close(); }
  });
});
