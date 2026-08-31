import { load, type CheerioAPI } from "cheerio";
import type { RawEntry } from "../shared/types";
import { compactText, parsePublishedAt } from "../shared/text";
import { assertPublicUrl, canonicalizeContentUrl, isTaxonomyUrl, toAbsoluteUrl } from "../shared/url";
import { PublicHttpClient } from "./http";

/** A metadata-only archive is bounded independently from normal source pages. */
export const MAX_ARCHIVE_DOCUMENT_BYTES = 8_000_000;
export const MAX_ARCHIVE_ENTRY_COUNT = 5_000;

export interface PublicArchive {
  url: string;
  entries: RawEntry[];
}

/**
 * Finds only author-linked archive pages. It never guesses conventional paths
 * such as /archive.html: an explicit same-origin link is required before any
 * additional source data is fetched.
 */
export async function discoverPublicArchive(http: PublicHttpClient, rawHomepageUrl: string): Promise<PublicArchive | undefined> {
  const homepage = await http.getText(rawHomepageUrl);
  for (const archiveUrl of explicitArchiveUrls(homepage.text, homepage.url)) {
    const archive = await http.getText(archiveUrl, undefined, { maxBytes: MAX_ARCHIVE_DOCUMENT_BYTES });
    const entries = parsePublishedArchive(archive.text, archive.url);
    if (entries.length >= 2) return { url: archive.url, entries };
  }
  return undefined;
}

/**
 * Extracts dated, same-origin post metadata from an already author-declared
 * archive page. It intentionally avoids article fetches and will fail closed
 * rather than silently truncate a very large archive.
 */
export function parsePublishedArchive(html: string, pageUrl: string): RawEntry[] {
  const $ = load(html);
  const page = assertPublicUrl(pageUrl);
  const entries = new Map<string, RawEntry & { score: number }>();
  for (const anchor of $("a[href]").toArray()) {
    const title = compactText($(anchor).text(), 240);
    const rawUrl = toAbsoluteUrl($(anchor).attr("href"), pageUrl);
    if (!title || !rawUrl || isAuxiliaryArchiveAnchor($, anchor, title)) continue;
    let url: URL;
    try {
      url = assertPublicUrl(rawUrl);
    } catch {
      continue;
    }
    if (url.origin !== page.origin || url.toString() === page.toString() || isTaxonomyUrl(url.toString())) continue;
    const publishedAt = archiveDate($, anchor);
    if (publishedAt === undefined) continue;
    const canonicalUrl = canonicalizeContentUrl(url.toString());
    const candidate = { url: canonicalUrl, title, publishedAt, score: archiveAnchorScore($, anchor, title) };
    const existing = entries.get(canonicalUrl);
    if (!existing || candidate.score > existing.score) entries.set(canonicalUrl, candidate);
    if (entries.size > MAX_ARCHIVE_ENTRY_COUNT) {
      throw new Error(`公开归档超过 ${MAX_ARCHIVE_ENTRY_COUNT} 篇，为避免意外批量导入已跳过。`);
    }
  }
  return [...entries.values()].map(({ score: _score, ...entry }) => entry);
}

function explicitArchiveUrls(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const page = assertPublicUrl(pageUrl);
  const urls: string[] = [];
  for (const anchor of $("a[href]").toArray()) {
    const href = toAbsoluteUrl($(anchor).attr("href"), pageUrl);
    if (!href) continue;
    let url: URL;
    try {
      url = assertPublicUrl(href);
    } catch {
      continue;
    }
    if (url.origin !== page.origin || !isExplicitArchiveAnchor($, anchor, url)) continue;
    if (!urls.includes(url.toString())) urls.push(url.toString());
    if (urls.length === 3) break;
  }
  return urls;
}

function isExplicitArchiveAnchor($: CheerioAPI, anchor: any, url: URL): boolean {
  const label = compactText(`${$(anchor).text()} ${$(anchor).attr("title") || ""} ${$(anchor).attr("aria-label") || ""}`, 240)?.toLowerCase() || "";
  const path = url.pathname.toLowerCase();
  return /(?:^|\/)(?:archive|archives)(?:\.(?:html?|php))?\/?$/i.test(path)
    || /(?:archive|archives|all\s+(?:posts|articles)|历史文章|文章归档|归档)/i.test(label);
}

function archiveDate($: CheerioAPI, anchor: any): number | undefined {
  const item = $(anchor).closest("li, article, tr, dd, dt").first();
  const scope = item.length ? item : $(anchor).parent();
  const dateNodes = scope.find("time[datetime], [data-published], [data-date], .archive-date, .date, [class*='date'], [class*='time']").toArray();
  for (const node of dateNodes) {
    const candidate = $(node).attr("datetime") || $(node).attr("data-published") || $(node).attr("data-date") || $(node).attr("content") || $(node).text();
    const parsed = parsePublishedAt(candidate);
    if (parsed !== undefined) return parsed;
  }
  return parsePublishedAt(scope.text());
}

/** Ignores navigation that often sits next to a real archive title link. */
function isAuxiliaryArchiveAnchor($: CheerioAPI, anchor: any, title: string): boolean {
  const text = title.trim().toLowerCase();
  const rel = ($(anchor).attr("rel") || "").toLowerCase();
  if (rel.split(/\s+/).includes("tag")) return true;
  return /^(?:comments?(?:\s*\(\d+\))?|评论(?:\s*\(\d+\))?|read\s+more|continue\s+reading|阅读全文|阅读更多|permalink|永久链接|share|分享|like|点赞)$/i.test(text);
}

/** Prefer a heading/title link when an archive row exposes supporting links. */
function archiveAnchorScore($: CheerioAPI, anchor: any, title: string): number {
  const titleContainer = $(anchor).closest("h1, h2, h3, h4, h5, h6, .title, .post-title, .entry-title, .archive-title").length > 0;
  const ownTitle = Boolean($(anchor).attr("title"));
  return (titleContainer ? 1_000 : 0) + (ownTitle ? 100 : 0) + Math.min(title.length, 80);
}
