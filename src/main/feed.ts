import RSSParser from "rss-parser";
import { load } from "cheerio";
import { compactText, parsePublishedAt } from "../shared/text";
import { toAbsoluteUrl } from "../shared/url";
import type { RawEntry } from "../shared/types";

const parser = new RSSParser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      // rss-parser's generic `content` field can be populated from a plain
      // <description>. Keep content:encoded distinct so the reader can
      // prefer the actual feed body when both are present.
      ["content:encoded", "contentEncoded"]
    ]
  }
});

// This is deliberately separate from the bounded card summary. Feed HTML is
// not durable data: it is retained only for the current fetch so the reader
// can sanitize it in memory if the linked page cannot be requested.
const MAX_TRANSIENT_FEED_HTML_LENGTH = 250_000;

/**
 * Bumped when feed-level metadata parsing changes. Existing RSS sources are
 * replayed once so cached cards can receive newly supported fields, then
 * resume normal conditional requests.
 */
export const RSS_METADATA_REVISION = 1;

/**
 * Older generic sources are rechecked once for a declared Feed. A Feed is
 * preferable to structural page extraction because it carries stable ids and
 * publication timestamps, and it does not depend on a site's visual layout.
 */
export const FEED_DISCOVERY_REVISION = 1;

export function looksLikeFeed(contentType: string, text: string): boolean {
  return /(?:rss|atom|feed\+json|xml)/i.test(contentType) || /^\s*<(?:\?xml[^>]*>)?\s*<(rss|feed)\b/i.test(text) || /^\s*\{/.test(text);
}

/**
 * Finds feeds declared by either the standard document head or a deliberate
 * page link such as a footer "RSS" button. The latter matters for sites that
 * publish a feed but omit the conventional `rel=alternate` declaration.
 *
 * This function only returns public, resolved candidates. Callers still fetch
 * them through PublicHttpClient, which applies the normal HTTPS/robots checks.
 */
export function discoverFeedUrls(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const discovered: string[] = [];
  const add = (rawHref: string | undefined, declared = false) => {
    const url = toAbsoluteUrl(rawHref, pageUrl);
    if (!url || (!declared && !isLikelyFeedUrl(url)) || discovered.includes(url)) return;
    discovered.push(url);
  };

  $("link[href]").each((_index, node) => {
    const link = $(node);
    const rel = link.attr("rel") || "";
    const type = link.attr("type") || "";
    const href = link.attr("href");
    const declaredFeed = /(?:rss|atom|feed\+json|application\/(?:json|xml))/i.test(`${rel} ${type}`);
    if (declaredFeed) add(href, true);
    else if (isLikelyFeedUrl(href, pageUrl)) add(href);
  });

  $("a[href]").each((_index, node) => {
    const link = $(node);
    const href = link.attr("href");
    // A path such as /rss.xml is an explicit feed endpoint even when the
    // visual button is an icon and has no accessible text. For less explicit
    // paths, require feed-related link text/metadata to avoid navigation.
    const label = `${link.text()} ${link.attr("title") || ""} ${link.attr("aria-label") || ""} ${link.attr("class") || ""}`;
    if (isLikelyFeedUrl(href, pageUrl) || /(?:rss|atom|feed|subscribe|syndicat)/i.test(label) && isFeedLikeQuery(href, pageUrl)) add(href);
  });

  return discovered.slice(0, 5);
}

function isLikelyFeedUrl(rawUrl: string | undefined, pageUrl = "https://example.invalid/"): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl, pageUrl);
    return /(?:^|\/)(?:rss|atom|feed)(?:[/.]|$)|\.(?:rss|atom|xml|json)$/i.test(url.pathname)
      || isFeedLikeQuery(url.toString(), pageUrl);
  } catch {
    return false;
  }
}

function isFeedLikeQuery(rawUrl: string | undefined, pageUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl, pageUrl);
    return [...url.searchParams.entries()].some(([key, value]) => /^(?:format|output|type)$/i.test(key) && /^(?:rss|atom|feed|json)$/i.test(value));
  } catch {
    return false;
  }
}

export async function parseFeed(text: string, feedUrl: string): Promise<{ title: string; entries: RawEntry[] }> {
  if (/^\s*\{/.test(text)) return parseJsonFeed(text, feedUrl);
  const feed = await parser.parseString(text);
  const entries: RawEntry[] = [];
  for (const item of feed.items || []) {
    const url = toAbsoluteUrl(item.link || item.guid, feedUrl);
    const title = compactText(item.title, 240);
    if (!url || !title) continue;
    entries.push({
      url,
      title,
      author: compactText(item.creator || (item as any).author, 120),
      publishedAt: parsePublishedAt(item.isoDate) ?? parsePublishedAt(item.pubDate),
      summary: compactText(item.contentSnippet || item.content || item.summary, 500),
      imageUrl: toAbsoluteUrl((item as any).mediaContent?.[0]?.$.url || item.enclosure?.url, feedUrl),
      feedContentHtml: transientFeedHtml((item as any).contentEncoded || item.content)
    });
  }
  return { title: compactText(feed.title, 180) || new URL(feedUrl).hostname, entries };
}

function parseJsonFeed(text: string, feedUrl: string): { title: string; entries: RawEntry[] } {
  const feed = JSON.parse(text);
  if (!feed.version || !Array.isArray(feed.items)) throw new Error("JSON 不符合 JSON Feed 格式。");
  const entries: RawEntry[] = [];
  for (const item of feed.items) {
    const url = toAbsoluteUrl(item.url || item.external_url || item.id, feedUrl);
    const title = compactText(item.title, 240);
    if (!url || !title) continue;
    entries.push({
      url,
      title,
      author: compactText(item.authors?.[0]?.name || item.author?.name, 120),
      publishedAt: parsePublishedAt(item.date_published) ?? parsePublishedAt(item.date_modified),
      summary: compactText(item.summary || item.content_text || stripHtml(item.content_html), 500),
      imageUrl: toAbsoluteUrl(item.image || item.banner_image, feedUrl),
      feedContentHtml: transientFeedHtml(item.content_html)
    });
  }
  return { title: compactText(feed.title, 180) || new URL(feedUrl).hostname, entries };
}

function stripHtml(value?: string): string | undefined {
  return value?.replace(/<[^>]*>/g, " ");
}

function transientFeedHtml(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const html = value.trim();
  // Truncating HTML would make the subsequent sanitizer operate on a broken
  // document. Prefer the already-persisted summary if a Feed item is too
  // large for the ephemeral reader path.
  return html && html.length <= MAX_TRANSIENT_FEED_HTML_LENGTH ? html : undefined;
}
