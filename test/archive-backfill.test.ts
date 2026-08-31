import { describe, expect, it, vi } from "vitest";
import { discoverPublicArchiveUrl, inspectPublicArchiveFacets, parsePublishedArchive } from "../src/main/archive-backfill";
import { RssConnector } from "../src/main/connectors";
import type { Source, Subscription, SubscriptionScope } from "../src/shared/types";

const ARCHIVE_HTML = `<html><body><nav><a href="/archive.html">归档</a></nav><ul class="archive-list">
  <li><span class="archive-date">2026-08-02</span><a href="/post/two.html">Second post</a><a rel="tag" href="/tags/ml">Machine Learning</a></li>
  <li><time datetime="2026-08-01">2026-08-01</time><a href="/post/one.html">First post</a><a class="archive-cats" href="/categories/systems.html">Systems</a></li>
  <li><a href="/tags/ml">Machine-learning tag</a></li>
</ul></body></html>`;

const ARCHIVE_WITH_SUPPORT_LINKS = `<html><body><ul>
  <li><time datetime="2026-08-03">2026-08-03</time>
    <a href="/post/three.html#comments">Comments (12)</a>
    <a href="/post/three.html">Read more</a>
    <h2><a href="/post/three.html">Clear article title</a></h2>
  </li>
</ul></body></html>`;

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><link>https://example.com/</link>
  <item><title>Newest post</title><link>/post/newest.html</link><pubDate>Sun, 03 Aug 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

function source(): Source {
  return {
    id: "source", url: "https://example.com/rss.xml", title: "Example", kind: "rss", connectorId: "rss", status: "active",
    pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
    config: { archiveCatalog: { url: "https://example.com/archive.html" } }
  };
}

function subscription(scope: SubscriptionScope = { facetSelections: [], history: { mode: "none" } }): Subscription {
  return { id: "source", sourceId: "source", connectorId: "rss", config: {}, scope, createdAt: 1, updatedAt: 1 };
}

describe("public archive backfill", () => {
  it("keeps only dated same-origin article metadata from an archive", () => {
    expect(parsePublishedArchive(ARCHIVE_HTML, "https://example.com/archive.html")).toEqual([
      expect.objectContaining({ url: "https://example.com/post/two.html", title: "Second post", publishedAt: Date.UTC(2026, 7, 2) }),
      expect.objectContaining({ url: "https://example.com/post/one.html", title: "First post", publishedAt: Date.UTC(2026, 7, 1) })
    ]);
  });

  it("selects a dated row's article title rather than comments or support links", () => {
    expect(parsePublishedArchive(ARCHIVE_WITH_SUPPORT_LINKS, "https://example.com/archive.html")).toEqual([
      expect.objectContaining({ url: "https://example.com/post/three.html", title: "Clear article title", publishedAt: Date.UTC(2026, 7, 3) })
    ]);
  });

  it("associates declared taxonomy links from the same dated archive row", () => {
    expect(parsePublishedArchive(ARCHIVE_HTML, "https://example.com/archive.html")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Second post",
        facets: [{ scheme: "feed:https://example.com:tag", key: "ml", label: "Machine Learning" }]
      }),
      expect.objectContaining({
        title: "First post",
        facets: [{ scheme: "feed:https://example.com:category", key: "systems", label: "Systems" }]
      })
    ]));
  });

  it("discovers an explicit same-origin archive link without downloading its back catalogue", async () => {
    const http = {
      getText: vi.fn(async (url: string) => url === "https://example.com/"
        ? { url, status: 200, contentType: "text/html", text: `<a href="/archive.html">归档</a>` }
        : { url, status: 200, contentType: "text/html", text: ARCHIVE_HTML })
    };

    await expect(discoverPublicArchiveUrl(http as any, "https://example.com/")).resolves.toBe("https://example.com/archive.html");
    expect(http.getText).toHaveBeenCalledTimes(1);
    expect(http.getText).toHaveBeenCalledWith("https://example.com/");
  });

  it("inspects archive facets only when explicitly requested", async () => {
    const http = {
      getText: vi.fn(async (url: string) => ({ url, status: 200, contentType: "text/html", text: ARCHIVE_HTML }))
    };

    await expect(inspectPublicArchiveFacets(http as any, "https://example.com/archive.html")).resolves.toEqual({
      url: "https://example.com/archive.html",
      totalEntries: 2,
      facets: expect.arrayContaining([
        { scheme: "feed:https://example.com:tag", key: "ml", label: "Machine Learning" },
        { scheme: "feed:https://example.com:category", key: "systems", label: "Systems" }
      ])
    });
    expect(http.getText).toHaveBeenCalledTimes(1);
  });

  it("keeps an archive descriptor feed-only until the user explicitly chooses history", async () => {
    const http = {
      getText: vi.fn(async (url: string) => url.endsWith("rss.xml")
        ? { url, status: 200, contentType: "application/rss+xml", text: FEED, etag: "feed" }
        : { url, status: 200, contentType: "text/html", text: ARCHIVE_HTML })
    };
    const connector = new RssConnector(http as any);
    const result = await connector.sync({ source: source(), subscription: subscription() });

    expect(result.entries.map((entry) => entry.title)).toEqual(["Newest post"]);
    expect(result.checkpoint).toBeUndefined();
    expect(http.getText).toHaveBeenCalledTimes(1);
  });

  it("imports only selected archive facets and checkpoints the selected scope", async () => {
    const http = {
      getText: vi.fn(async (url: string) => url.endsWith("rss.xml")
        ? { url, status: 200, contentType: "application/rss+xml", text: FEED, etag: "feed" }
        : { url, status: 200, contentType: "text/html", text: ARCHIVE_HTML })
    };
    const connector = new RssConnector(http as any);
    const scope: SubscriptionScope = {
      facetSelections: [{ scheme: "feed:https://example.com:tag", key: "ml", label: "Machine Learning" }],
      history: { mode: "selected", limit: 50 }
    };
    const result = await connector.sync({ source: source(), subscription: subscription(scope) });

    expect(result.entries.map((entry) => entry.title)).toEqual(["Newest post", "Second post"]);
    expect(result.checkpoint?.data).toMatchObject({ archiveHistory: { importedEntries: 1, completedAt: expect.any(Number) } });

    const callsBeforeRetry = http.getText.mock.calls.length;
    http.getText.mockImplementation(async (url: string) => ({ url, status: 304, contentType: "application/rss+xml", text: "" }));
    const retry = await connector.sync({
      source: source(),
      subscription: subscription(scope),
      checkpoint: { subscriptionId: "source", data: result.checkpoint?.data, updatedAt: 2 }
    });
    expect(retry).toMatchObject({ entries: [], notModified: true });
    expect(http.getText).toHaveBeenCalledTimes(callsBeforeRetry + 1);
  });

  it("keeps the current Feed metadata when its archive repeats the same article", async () => {
    const overlappingFeed = FEED.replace("Newest post", "Current Feed title").replace("/post/newest.html", "/post/one.html");
    const http = {
      getText: vi.fn(async (url: string) => url.endsWith("rss.xml")
        ? { url, status: 200, contentType: "application/rss+xml", text: overlappingFeed }
        : { url, status: 200, contentType: "text/html", text: ARCHIVE_HTML })
    };
    const result = await new RssConnector(http as any).sync({
      source: source(), subscription: subscription({ facetSelections: [], history: { mode: "all" } })
    });

    expect(result.entries.map((entry) => entry.title)).toEqual(["Current Feed title", "Second post"]);
    expect(result.entries[0]?.facets).toEqual([
      { scheme: "feed:https://example.com:category", key: "systems", label: "Systems" }
    ]);
  });

  it("keeps a healthy Feed active when its optional archive is unavailable", async () => {
    const http = {
      getText: vi.fn(async (url: string) => {
        if (url.endsWith("rss.xml")) return { url, status: 200, contentType: "application/rss+xml", text: FEED };
        throw new Error("archive temporarily unavailable");
      })
    };
    const result = await new RssConnector(http as any).sync({
      source: source(), subscription: subscription({ facetSelections: [], history: { mode: "all" } })
    });

    expect(result.entries).toHaveLength(1);
    expect(result.checkpoint?.data).toMatchObject({ archiveHistory: { attempts: 1 } });
  });
});
