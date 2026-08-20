import { describe, expect, it } from "vitest";
import { GenericConnector, RssConnector } from "../src/main/connectors";
import { PUBLICATION_DATE_REVISION } from "../src/main/extractor";
import { FEED_DISCOVERY_REVISION, RSS_METADATA_REVISION } from "../src/main/feed";
import type { Source } from "../src/shared/types";

describe("GenericConnector", () => {
  it("performs one unconditional refresh for a legacy automatic rule, then stamps its repair revision", async () => {
    let receivedOptions: unknown = "not-called";
    const http = {
      getText: async (_url: string, options: unknown) => {
        receivedOptions = options;
        return {
          url: "https://example.com/",
          text: `<main><ul><li>16 Jul 2026 <a href="/one">A sufficiently descriptive first post</a></li><li>15 Jul 2026 <a href="/two">A sufficiently descriptive second post</a></li></ul></main>`,
          status: 200
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://example.com/", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      etag: "old-etag", lastModified: "Fri, 17 Jul 2026 12:20:57 GMT",
      extractionRule: { version: 1, itemRootSelector: "li" }
    };
    const connector = new GenericConnector(http as any, {} as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.entries).toHaveLength(2);
    expect(outcome.extractionRule?.autoRepairRevision).toBeDefined();
  });

  it("replays a generic source once after a publication-date parser upgrade", async () => {
    let receivedOptions: unknown = "not-called";
    const http = {
      getText: async (_url: string, options: unknown) => {
        receivedOptions = options;
        return {
          url: "https://example.com/post",
          text: `<meta property="og:title" content="A dated post"><meta property="article:published_time" content="2026-08-16">`,
          status: 200
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://example.com/post", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      etag: "unchanged", lastModified: "Sat, 16 Aug 2026 12:20:57 GMT",
      extractionRule: { version: 1, publicationDateRevision: 0 }
    };
    const connector = new GenericConnector(http as any, {} as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.entries[0]).toMatchObject({ publishedAt: Date.UTC(2026, 7, 16) });
    expect(outcome.extractionRule?.publicationDateRevision).toBe(PUBLICATION_DATE_REVISION);
  });

  it("upgrades an existing web source to a verified footer Feed", async () => {
    const requests: Array<{ url: string; options: unknown }> = [];
    const http = {
      getText: async (url: string, options: unknown) => {
        requests.push({ url, options });
        if (url.endsWith("/rss.xml")) {
          return {
            url,
            status: 200,
            contentType: "application/rss+xml",
            etag: "feed-etag",
            lastModified: "Tue, 18 Aug 2026 05:44:39 GMT",
            text: `<?xml version="1.0"?><rss version="2.0"><channel><title>AINews</title><item><title>Newest issue</title><link>/issues/latest</link><pubDate>Tue, 18 Aug 2026 05:44:39 GMT</pubDate></item></channel></rss>`
          };
        }
        return {
          url,
          status: 200,
          contentType: "text/html",
          text: `<html><body><footer><a href="/rss.xml">RSS</a></footer></body></html>`
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://news.example/", title: "AINews", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      etag: "home-etag", lastModified: "Mon, 17 Aug 2026 12:00:00 GMT",
      extractionRule: { version: 1, publicationDateRevision: PUBLICATION_DATE_REVISION }
    };
    const connector = new GenericConnector(http as any, {} as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(requests).toEqual([
      { url: "https://news.example/", options: undefined },
      { url: "https://news.example/rss.xml", options: undefined }
    ]);
    expect(outcome.entries).toEqual([expect.objectContaining({
      title: "Newest issue",
      url: "https://news.example/issues/latest",
      publishedAt: Date.UTC(2026, 7, 18)
    })]);
    expect(outcome.extractionRule).toMatchObject({
      feedUrl: "https://news.example/rss.xml",
      feedDiscoveryRevision: FEED_DISCOVERY_REVISION
    });
    expect(outcome.etag).toBe("feed-etag");
  });
});

describe("RssConnector", () => {
  it("replays a legacy feed once to backfill parser metadata, then records its revision", async () => {
    let receivedOptions: unknown = "not-called";
    const http = {
      getText: async (_url: string, options: unknown) => {
        receivedOptions = options;
        return {
          url: "https://example.com/feed.xml",
          status: 200,
          text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>Dated post</title><link>/post</link><pubDate>Sun, 04 Feb 2024 17:23:27 -0600</pubDate></item></channel></rss>`
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://example.com/feed.xml", title: "Example", kind: "rss", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      etag: "unchanged", lastModified: "Sun, 04 Feb 2024 23:23:27 GMT", metadataRevision: 0
    };
    const connector = new RssConnector(http as any, {} as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.entries).toEqual([expect.objectContaining({ publishedAt: Date.UTC(2024, 1, 4) })]);
    expect(outcome.metadataRevision).toBe(RSS_METADATA_REVISION);
  });
});
