import { describe, expect, it, vi } from "vitest";
import { GenericConnector, RssConnector } from "../src/main/connectors";
import { AUTOMATIC_RULE_REVISION, PUBLICATION_DATE_REVISION } from "../src/main/extractor";
import { FEED_DISCOVERY_REVISION, RSS_METADATA_REVISION } from "../src/main/feed";
import { ResponseTooLargeError } from "../src/main/http";
import type { Source } from "../src/shared/types";

describe("GenericConnector", () => {
  it("uses a same-site article identity when a legacy rule returns the source homepage", () => {
    const connector = new GenericConnector({} as any);
    const source: Source = {
      id: "source", url: "http://heavensheep.xyz/", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };
    const normalised = connector.normalize({
      url: source.url,
      canonicalIdentity: "http://heavensheep.xyz/?p=577",
      title: "Actual post"
    }, source);
    expect(normalised).toMatchObject({
      url: "http://heavensheep.xyz/?p=577",
      canonicalUrl: "http://heavensheep.xyz/?p=577",
      canonicalIdentity: "http://heavensheep.xyz/?p=577"
    });
  });

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
    const connector = new GenericConnector(http as any);

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
    const connector = new GenericConnector(http as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.entries[0]).toMatchObject({ publishedAt: Date.UTC(2026, 7, 16) });
    expect(outcome.extractionRule?.publicationDateRevision).toBe(PUBLICATION_DATE_REVISION);
  });

  it("enriches missing homepage dates from public article metadata without retaining article HTML", async () => {
    const requests: string[] = [];
    const http = {
      getText: async (url: string) => {
        requests.push(url);
        if (url.endsWith("/one")) return {
          url,
          text: `<article><header><h1>First dated post</h1><time datetime="2026-08-19">August 19, 2026</time></header></article>`,
          status: 200,
          contentType: "text/html"
        };
        if (url.endsWith("/2026-08-18/two")) return { url, text: "<article><h1>Second dated post</h1></article>", status: 200, contentType: "text/html" };
        return {
          url,
          text: `<main><article><a href="/one">First dated post</a><p>A sufficiently detailed first summary for reliable card extraction.</p></article><article><a href="/2026-08-18/two">Second dated post</a><p>A sufficiently detailed second summary for reliable card extraction.</p></article></main>`,
          status: 200,
          contentType: "text/html"
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://example.com/", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      extractionRule: { version: 1, publicationDateRevision: PUBLICATION_DATE_REVISION, feedDiscoveryRevision: FEED_DISCOVERY_REVISION }
    };
    const connector = new GenericConnector(http as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(outcome.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://example.com/one", publishedAt: Date.UTC(2026, 7, 19) }),
      expect.objectContaining({ url: "https://example.com/2026-08-18/two", publishedAt: Date.UTC(2026, 7, 18) })
    ]));
    expect(requests).toContain("https://example.com/one");
    expect(requests).not.toContain("https://example.com/2026-08-18/two");
  });

  it("repairs an automatic bibliography rule in favour of a named one-post blog section", async () => {
    const requests: Array<{ url: string; options: unknown }> = [];
    const http = {
      getText: async (url: string, options: unknown) => {
        requests.push({ url, options });
        return {
          url,
          status: 200,
          contentType: "text/html",
          text: `<section>
            <h2 id="selected-publications">Selected Publications</h2>
            <ol class="bibliography">
              <li><div class="title"><a href="https://papers.example/one">A long publication title that should not become a blog card</a></div></li>
              <li><div class="title"><a href="https://papers.example/two">Another long publication title that should not become a blog card</a></div></li>
            </ol>
            <h2 id="blogs">Blog Posts</h2>
            <div class="blogs"><div class="blog-row"><div class="blog-content">
              <div class="blog-title"><a href="/blog/2026/08/27/beyond-RL/">A Gallery of Methods Beyond RL — Part I: Sampling Methods</a></div>
              <div class="blog-description">A tour of methods beyond reinforcement learning.</div>
            </div><div class="blog-date">Aug 2026</div></div></div>
          </section>`
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://shengyu-feng.github.io/", title: "Shengyu Feng", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      extractionRule: {
        version: 1,
        itemRootSelector: "li",
        autoRepairRevision: AUTOMATIC_RULE_REVISION - 1,
        publicationDateRevision: PUBLICATION_DATE_REVISION,
        feedDiscoveryRevision: FEED_DISCOVERY_REVISION
      }
    };
    const connector = new GenericConnector(http as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(outcome.entries).toEqual([
      expect.objectContaining({
        url: "https://shengyu-feng.github.io/blog/2026/08/27/beyond-RL/",
        title: "A Gallery of Methods Beyond RL — Part I: Sampling Methods",
        publishedAt: Date.UTC(2026, 7, 27)
      })
    ]);
    expect(outcome.extractionRule?.itemRootSelector).toBe("h2#blogs + div.blogs div.blog-row");
    expect(requests).toEqual([{ url: "https://shengyu-feng.github.io/", options: undefined }]);
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
    const connector = new GenericConnector(http as any);

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
    expect(outcome.metadataRevision).toBe(RSS_METADATA_REVISION);
  });

  it("replays a declared Feed after an RSS metadata parser upgrade", async () => {
    let receivedOptions: unknown = "not-called";
    const http = {
      getText: async (_url: string, options: unknown) => {
        receivedOptions = options;
        return {
          url: "https://example.com/feed.xml",
          status: 200,
          contentType: "application/rss+xml",
          text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title>Fresh article</title><link>/fresh</link><pubDate>Tue, 18 Aug 2026 05:44:39 GMT</pubDate></item></channel></rss>`
        };
      }
    };
    const source: Source = {
      id: "source", url: "https://example.com/", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      etag: "stale", lastModified: "Tue, 18 Aug 2026 05:44:39 GMT",
      metadataRevision: RSS_METADATA_REVISION - 1,
      extractionRule: { version: 1, feedUrl: "https://example.com/feed.xml", publicationDateRevision: PUBLICATION_DATE_REVISION }
    };
    const connector = new GenericConnector(http as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.metadataRevision).toBe(RSS_METADATA_REVISION);
    expect(outcome.entries).toEqual([expect.objectContaining({ title: "Fresh article" })]);
  });

  it("uses and persists isolated rendering when a generic page exceeds the static response budget", async () => {
    const http = {
      getText: async () => {
        throw new ResponseTooLargeError(3_000_000, "text/html", "https://example.com/", 3_000_001);
      }
    };
    const renderer = {
      render: vi.fn().mockResolvedValue(`<main><ul>
        <li><a href="/one">A sufficiently descriptive first post</a><time datetime="2026-08-20">20 Aug 2026</time></li>
        <li><a href="/two">A sufficiently descriptive second post</a><time datetime="2026-08-19">19 Aug 2026</time></li>
      </ul></main>`)
    };
    const source: Source = {
      id: "source", url: "https://example.com/", title: "Example", kind: "generic", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
      extractionRule: { version: 1, publicationDateRevision: PUBLICATION_DATE_REVISION, feedDiscoveryRevision: FEED_DISCOVERY_REVISION }
    };
    const connector = new GenericConnector(http as any, renderer as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(outcome.entries).toHaveLength(2);
    expect(outcome.extractionRule).toMatchObject({ rendererRequired: true });
    expect(renderer.render).toHaveBeenCalledWith("https://example.com/", undefined);
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
    const connector = new RssConnector(http as any);

    const outcome = await connector.fetchWithMetadata(source);

    expect(receivedOptions).toBeUndefined();
    expect(outcome.entries).toEqual([expect.objectContaining({ publishedAt: Date.UTC(2024, 1, 4) })]);
    expect(outcome.metadataRevision).toBe(RSS_METADATA_REVISION);
  });
});
