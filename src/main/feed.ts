import RSSParser from "rss-parser";
import { compactText, parsePublishedAt } from "../shared/text";
import { toAbsoluteUrl } from "../shared/url";
import type { RawEntry } from "../shared/types";

const parser = new RSSParser({
  customFields: {
    item: [["media:content", "mediaContent", { keepArray: true }]]
  }
});

/**
 * Bumped when feed-level metadata parsing changes. Existing RSS sources are
 * replayed once so cached cards can receive newly supported fields, then
 * resume normal conditional requests.
 */
export const RSS_METADATA_REVISION = 1;

export function looksLikeFeed(contentType: string, text: string): boolean {
  return /(?:rss|atom|feed\+json|xml)/i.test(contentType) || /^\s*<(?:\?xml[^>]*>)?\s*<(rss|feed)\b/i.test(text) || /^\s*\{/.test(text);
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
      imageUrl: toAbsoluteUrl((item as any).mediaContent?.[0]?.$.url || item.enclosure?.url, feedUrl)
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
      imageUrl: toAbsoluteUrl(item.image || item.banner_image, feedUrl)
    });
  }
  return { title: compactText(feed.title, 180) || new URL(feedUrl).hostname, entries };
}

function stripHtml(value?: string): string | undefined {
  return value?.replace(/<[^>]*>/g, " ");
}
