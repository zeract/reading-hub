import { describe, expect, it } from "vitest";
import { GenericConnector, RssConnector } from "../src/main/connectors";
import { PUBLICATION_DATE_REVISION } from "../src/main/extractor";
import { RSS_METADATA_REVISION } from "../src/main/feed";
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
