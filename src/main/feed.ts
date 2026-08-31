import RSSParser from "rss-parser";
import { load } from "cheerio";
import { compactText, parsePublishedAt } from "../shared/text";
import { toAbsoluteUrl } from "../shared/url";
import type { RawEntry } from "../shared/types";

const parser = new RSSParser({
  customFields: {
    // Keep the namespaced key intact: rss-parser's typed configuration only
    // accepts field names here, and feedIconUrl normalizes it below.
    feed: ["itunes:image"],
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
export const RSS_METADATA_REVISION = 4;

/**
 * Older generic sources are rechecked once for a declared Feed. A Feed is
 * preferable to structural page extraction because it carries stable ids and
 * publication timestamps, and it does not depend on a site's visual layout.
 */
export const FEED_DISCOVERY_REVISION = 1;

/** A MIME type that explicitly identifies a syndication document. */
export function isExplicitFeedContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/rss+xml"
    || mediaType === "application/atom+xml"
    || mediaType === "application/feed+json";
}

/**
 * MIME types frequently used for a Feed but too broad to trust on their own.
 * A response using one of these types must also expose a Feed signature before
 * it receives the larger, Feed-specific byte budget.
 */
export function isAmbiguousFeedContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/xml"
    || mediaType === "text/xml"
    || mediaType === "application/rdf+xml"
    || mediaType === "application/json"
    || mediaType === "text/json"
    || mediaType === "text/plain"
    || mediaType === "";
}

/**
 * Checks only the small leading portion of a response. It deliberately does
 * not accept every JSON object: a larger transfer is granted only to a JSON
 * Feed with its required version marker, not arbitrary API data.
 */
export function hasFeedSignature(text: string): boolean {
  const prefix = text.replace(/^\uFEFF?\s*/, "");
  // A MIME type can be wrong, so only the actual document root earns the
  // larger Feed budget. Comments and an XML declaration are allowed before
  // the root; arbitrary XML/JSON payloads are not Feed signatures.
  const xml = prefix
    .replace(/^(?:<\?xml[^>]*>\s*)?/i, "")
    .replace(/^(?:<!--[\s\S]*?-->\s*)*/i, "")
    .replace(/^(?:<!DOCTYPE[^>]*>\s*)*/i, "");
  return /^<(?:rss|feed|rdf:RDF)\b/i.test(xml)
    || /^\{[\s\S]{0,65536}?"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\//i.test(prefix);
}

export function looksLikeFeed(_contentType: string, text: string): boolean {
  // MIME types are discovery hints only: a site can mislabel a perfectly
  // valid Feed, but a raw document must still expose the Feed root/version
  // before parser work begins. This prevents arbitrary JSON/XML endpoints
  // from being classified merely by their Content-Type header.
  return hasFeedSignature(text);
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

export interface ParsedFeed {
  title: string;
  entries: RawEntry[];
  iconUrl?: string;
  /** Feed-declared public homepage; used only to discover an explicit archive link. */
  siteUrl?: string;
}

export async function parseFeed(text: string, feedUrl: string): Promise<ParsedFeed> {
  const normalizedText = text.replace(/^\uFEFF?\s*/, "");
  if (/^\{/.test(normalizedText)) return parseJsonFeed(normalizedText, feedUrl);
  const feed = await parser.parseString(text);
  const feedTitle = compactText(feed.title, 180);
  const entries: RawEntry[] = [];
  for (const item of feed.items || []) {
    const url = toAbsoluteUrl(item.link || item.guid, feedUrl);
    const title = compactText(item.title, 240);
    if (!url || !title) continue;
    const publishedAt = parsePublishedAt(item.isoDate) ?? parsePublishedAt(item.pubDate);
    const summary = compactText(item.contentSnippet || item.content || item.summary, 500);
    const feedContentHtml = transientFeedHtml((item as any).contentEncoded || item.content);
    const imageUrl = toAbsoluteUrl((item as any).mediaContent?.[0]?.$.url || item.enclosure?.url, feedUrl);
    if (isFeedNavigationLink({ url, title, publishedAt, summary, feedContentHtml, imageUrl }, feedUrl, feedTitle)) continue;
    entries.push({
      url,
      title,
      author: compactText(item.creator || (item as any).author, 120),
      publishedAt,
      summary,
      imageUrl,
      feedContentHtml
    });
  }
  return {
    title: compactText(feed.title, 180) || new URL(feedUrl).hostname,
    entries,
    iconUrl: feedIconUrl(feed, feedUrl),
    siteUrl: toAbsoluteUrl(feed.link, feedUrl)
  };
}

/**
 * A few hand-authored RSS documents put footer links such as “GitHub” and
 * “X” in `<item>` elements. They have no article metadata or body and would
 * otherwise become undated cards. Keep legitimate sparse feed posts intact;
 * only reject an exact source-home link or a clearly-labelled social link.
 */
function isFeedNavigationLink(
  entry: Pick<RawEntry, "url" | "title" | "publishedAt" | "summary" | "feedContentHtml" | "imageUrl">,
  feedUrl: string,
  feedTitle: string | undefined
): boolean {
  if (entry.publishedAt !== undefined || entry.summary || entry.feedContentHtml || entry.imageUrl) return false;
  try {
    const entryUrl = new URL(entry.url);
    const sourceUrl = new URL(feedUrl);
    if (entryUrl.origin === sourceUrl.origin
      && (entryUrl.pathname === sourceUrl.pathname && entryUrl.search === sourceUrl.search || Boolean(feedTitle && entry.title === feedTitle))) return true;
    if (!/^(?:www\.)?(?:github|x|twitter|facebook|linkedin|instagram|youtube)\.com$/i.test(entryUrl.hostname)) return false;
    return /^(?:github|x(?:\s*\(@[^)]+\))?|twitter|facebook|linkedin|instagram|youtube)$/i.test(entry.title)
      || Boolean(feedTitle && entry.title === feedTitle);
  } catch {
    return false;
  }
}

function parseJsonFeed(text: string, feedUrl: string): ParsedFeed {
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
  return {
    title: compactText(feed.title, 180) || new URL(feedUrl).hostname,
    entries,
    iconUrl: toAbsoluteUrl(feed.icon || feed.favicon, feedUrl),
    siteUrl: toAbsoluteUrl(feed.home_page_url, feedUrl)
  };
}

/** Extracts only the Feed-declared logo URL; callers still apply public URL validation before persistence. */
function feedIconUrl(feed: any, feedUrl: string): string | undefined {
  const itunesImage = feed.itunesImage ?? feed["itunes:image"];
  const itunesHref = typeof itunesImage === "string" ? itunesImage : itunesImage?.href ?? itunesImage?.$?.href;
  const candidate = feed.image?.url || feed.icon || feed.logo || itunesHref;
  return toAbsoluteUrl(candidate, feedUrl);
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
