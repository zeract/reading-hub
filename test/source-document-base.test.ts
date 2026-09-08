import { describe, expect, it, vi } from "vitest";
import { AUTOMATIC_RULE_REVISION, PUBLICATION_DATE_REVISION, extractCalibrationCandidates, extractGenericPage } from "../src/main/extractor";
import { FEED_DISCOVERY_REVISION, discoverFeedUrls } from "../src/main/feed";
import { findPublicArchiveUrls, parsePublishedArchive } from "../src/main/archive-backfill";
import { GenericConnector } from "../src/main/connectors";
import type { Source } from "../src/shared/types";
const pageUrl = "https://example.com/site/index.html";
const base = '<base href="/blog/">';
const cards = ["one", "two"].map((id) => `<article><h2><a href="${id}.html">A sufficiently descriptive article title ${id}</a></h2><time datetime="2026-08-02">2026-08-02</time><img src="${id}.png"><p>A substantial summary about this synthetic article and its subject.</p></article>`).join("");

it("rechecks pre-base sources once despite validators, then resumes conditional polling", async () => {
  const getText = vi.fn(async (url: string, cached: unknown) => cached
    ? { url, status: 304, text: "", etag: "fixture-etag", contentType: "text/html" }
    : { url, status: 200, text: base + cards, etag: "fixture-etag", contentType: "text/html" });
  const connector = new GenericConnector({ getText } as any);
  const source: Source = { id: "fixture", url: pageUrl, title: "Fixture", kind: "generic", status: "active", pollingEnabled: true,
    createdAt: 1, updatedAt: 1, failureCount: 0, consecutiveEmpty: 0, etag: "fixture-etag", validatorUrl: pageUrl,
    extractionRule: { version: 1, itemRootSelector: "article", autoRepairRevision: AUTOMATIC_RULE_REVISION, publicationDateRevision: PUBLICATION_DATE_REVISION, feedDiscoveryRevision: 1 } };
  const first = await connector.fetchWithMetadata(source);
  expect(getText.mock.calls[0][1]).toBeUndefined();
  expect(first.entries[0].url).toBe("https://example.com/blog/one.html");
  expect(first.extractionRule?.feedDiscoveryRevision).toBe(FEED_DISCOVERY_REVISION);
  const restoredRule = JSON.parse(JSON.stringify(first.extractionRule));
  const next = await connector.fetchWithMetadata({ ...source, extractionRule: restoredRule });
  expect(next.notModified).toBe(true);
  expect(getText.mock.calls[1][1]).toMatchObject({ etag: "fixture-etag" });
  expect(getText).toHaveBeenCalledTimes(2);
});

it("resolves automatic cards and calibrated replay against the declared base", () => {
  const html = base + cards;
  const result = extractGenericPage(html, pageUrl);
  expect(result.entries.map((item) => item.url)).toEqual(["https://example.com/blog/one.html", "https://example.com/blog/two.html"]);
  expect(result.entries[0].imageUrl).toBe("https://example.com/blog/one.png");
  expect(extractGenericPage(html, pageUrl, result.rule).entries).toEqual(result.entries);
  const candidates = extractCalibrationCandidates(html, pageUrl);
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of candidates) expect(extractGenericPage(html, pageUrl, candidate.rule).entries.slice(0, 4)).toEqual(candidate.preview);
});

it("preserves calibrated raw-href selectors and excludes the actual current page", () => {
  const result = extractGenericPage(base + cards + '<article><a href="../site/index.html">Current page</a></article>', pageUrl,
    { version: 1, itemRootSelector: 'article:has(a[href="one.html"]), article:has(a[href="../site/index.html"])', titleSelector: 'a' });
  expect(result.entries.map((item) => item.url)).toEqual(["https://example.com/blog/one.html"]);
});

it("resolves JSON-LD URLs and images using the same document base", () => {
  const result = extractGenericPage(base + '<script type="application/ld+json">{"@type":"Article","headline":"Fixture","url":"one.html","image":"cover.png"}</script>', pageUrl);
  expect(result.entries[0]).toMatchObject({ url: "https://example.com/blog/one.html", imageUrl: "https://example.com/blog/cover.png" });
});

it("does not persist resolved path selectors absent from authored link attributes", () => {
  const html = base + ["one", "two"].map((id) => `<a href="${id}.html"><h2>A sufficiently descriptive article title ${id}</h2><time datetime="2026-08-02"></time><p>A substantial article summary for deterministic selection.</p></a>`).join("");
  for (const candidate of extractCalibrationCandidates(html, pageUrl)) {
    expect(extractGenericPage(html, pageUrl, candidate.rule).entries.slice(0, 4)).toEqual(candidate.preview);
  }
  expect(extractGenericPage(html, pageUrl, { version: 1, itemRootSelector: 'a[href]', titleSelector: 'h2' }).entries.map((item) => item.url)).toEqual(["https://example.com/blog/one.html", "https://example.com/blog/two.html"]);
});

it("resolves Open Graph metadata but preserves actual page identity when URL metadata is absent", () => {
  const metadata = base + '<title>Fixture</title><meta property="og:image" content="cover.png">';
  expect(extractGenericPage(metadata, pageUrl).entries[0]).toMatchObject({ url: pageUrl, imageUrl: "https://example.com/blog/cover.png" });
  expect(extractGenericPage(metadata + '<meta property="og:url" content="post.html">', pageUrl).entries[0].url).toBe("https://example.com/blog/post.html");
});

it("discovers declared and linked feeds relative to the base and deduplicates resolved URLs", () => {
  const html = base + '<link rel="alternate" type="application/rss+xml" href="feed.xml"><a href="/blog/feed.xml">RSS</a><a href="?format=atom">Subscribe</a>';
  expect(discoverFeedUrls(html, pageUrl)).toEqual(["https://example.com/blog/feed.xml", "https://example.com/blog/?format=atom"]);
});

it("resolves archives and dated entries without changing taxonomy provenance", () => {
  const html = base + '<a href="archive.html">Archives</a><ul><li><time datetime="2026-08-02"></time><a href="post.html">A dated article</a><a rel="tag" href="tags/ml">Machine learning</a></li></ul>';
  expect(findPublicArchiveUrls(html, pageUrl)).toEqual(["https://example.com/blog/archive.html"]);
  expect(parsePublishedArchive(html, pageUrl)).toEqual([expect.objectContaining({ url: "https://example.com/blog/post.html", publishedAt: Date.UTC(2026, 7, 2), facets: [{ scheme: "feed:https://example.com:tag", key: "ml", label: "Machine learning" }] })]);
});

it("keeps archive origin restrictions anchored to the actual page", () => {
  const html = '<base href="https://other.example/blog/"><a href="archive.html">Archives</a><li><time datetime="2026-08-02"></time><a href="post.html">A dated article</a><a rel="tag" href="tags/ml">Machine learning</a></li>';
  expect(findPublicArchiveUrls(html, pageUrl)).toEqual([]);
  expect(parsePublishedArchive(html, pageUrl)).toEqual([]);
});

it("does not promote off-origin base links to a same-origin semantic blog section", () => {
  const html = '<base href="https://other.example/blog/"><h2>Blog Posts</h2><ul><li><a href="post.html">A sufficiently descriptive article title</a><time datetime="2026-08-02"></time><p>A substantial summary with more information about this article.</p></li></ul>';
  expect(extractCalibrationCandidates(html, pageUrl).some((candidate) => candidate.label.includes('博客文章'))).toBe(false);
});

it.each(["http://127.0.0.1/", "file:///tmp/", "https://user:pass@example.com/"])("does not advertise feed candidates from a disallowed base %s", (href) => {
  expect(discoverFeedUrls(`<base href="${href}"><link type="application/rss+xml" href="feed.xml"><link type="application/rss+xml" href="https://public.example/feed.xml">`, pageUrl)).toEqual(["https://public.example/feed.xml"]);
});

describe.each(["http://127.0.0.1/", "file:///tmp/", "https://user:pass@example.com/"])("generic source disallowed base %s", (href) => {
  it("rejects resolved card URLs and images before preview or persistence", () => {
    const html = `<base href="${href}">` + cards;
    expect(extractCalibrationCandidates(html, pageUrl)).toEqual([]);
    const result = extractGenericPage(html, pageUrl, { version: 1, itemRootSelector: "article", titleSelector: "a" });
    expect(result.entries.every((item) => item.url === pageUrl)).toBe(true);
    expect(result.entries.every((item) => item.imageUrl === undefined)).toBe(true);
  });
  it("rejects resolved JSON-LD URLs but preserves explicit public entries", () => {
    const html = `<base href="${href}"><script type="application/ld+json">[{"@type":"Article","headline":"Unsafe fixture","url":"one.html"},{"@type":"Article","headline":"Public fixture","url":"https://public.example/post","image":"cover.png"}]</script>`;
    expect(extractGenericPage(html, pageUrl).entries).toEqual([expect.objectContaining({ url: "https://public.example/post", imageUrl: undefined })]);
  });
});
