import { load, type CheerioAPI } from "cheerio";
import type { Facet, FacetCatalog, RawEntry } from "../shared/types";
import { compactText, parsePublishedAt } from "../shared/text";
import { assertPublicUrl, canonicalizeContentUrl, isTaxonomyUrl, toAbsoluteUrl } from "../shared/url";
import { PublicHttpClient } from "./http";
import { canonicalFacetKey, publisherFacet, uniqueFacets } from "./content-facets";

/** A metadata-only archive is bounded independently from normal source pages. */
export const MAX_ARCHIVE_DOCUMENT_BYTES = 8_000_000;
export const MAX_ARCHIVE_ENTRY_COUNT = 5_000;

/** A bounded, metadata-only catalogue for an explicit history-import choice. */
export interface ArchiveFacetCatalog extends FacetCatalog {
  url: string;
}

/**
 * Finds an explicit archive URL without reading the archive itself. This is
 * safe to use during source preview: it preserves the publisher's declared
 * history capability without downloading a potentially large back catalogue.
 */
export async function discoverPublicArchiveUrl(http: PublicHttpClient, rawHomepageUrl: string): Promise<string | undefined> {
  const homepageUrl = assertPublicUrl(rawHomepageUrl).toString();
  const homepage = await http.getText(homepageUrl);
  return explicitArchiveUrls(homepage.text, homepage.url)[0];
}

/**
 * Reads an already selected public archive through the regular robots-aware
 * client and returns only the available facet catalogue/count. It does not
 * save article content and callers must still ask the user before importing
 * any history.
 */
export async function inspectPublicArchiveFacets(http: PublicHttpClient, rawArchiveUrl: string): Promise<ArchiveFacetCatalog> {
  const archiveUrl = assertPublicUrl(rawArchiveUrl).toString();
  const archive = await http.getText(archiveUrl, undefined, { maxBytes: MAX_ARCHIVE_DOCUMENT_BYTES });
  const entries = parsePublishedArchive(archive.text, archive.url);
  return { url: archive.url, facets: archiveFacets(entries), totalEntries: entries.length };
}

/** Finds archive URLs from an already fetched public homepage. */
export function findPublicArchiveUrls(html: string, pageUrl: string): string[] {
  return explicitArchiveUrls(html, pageUrl);
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
    if (url.origin !== page.origin || url.toString() === page.toString() || isArchiveTaxonomyUrl(url.toString())) continue;
    const scope = archiveItemScope($, anchor);
    const publishedAt = archiveDate($, scope);
    if (publishedAt === undefined) continue;
    const canonicalUrl = canonicalizeContentUrl(url.toString());
    const facets = archiveEntryFacets($, scope, pageUrl, anchor);
    const candidate = withFacets({ url: canonicalUrl, title, publishedAt, score: archiveAnchorScore($, anchor, title) }, facets);
    const existing = entries.get(canonicalUrl);
    if (!existing || candidate.score > existing.score) entries.set(canonicalUrl, candidate);
    if (entries.size > MAX_ARCHIVE_ENTRY_COUNT) {
      throw new Error(`公开归档超过 ${MAX_ARCHIVE_ENTRY_COUNT} 篇，为避免意外批量导入已跳过。`);
    }
  }
  return [...entries.values()].map(({ score: _score, ...entry }) => entry);
}

function archiveFacets(entries: RawEntry[]): Facet[] {
  return uniqueFacets(entries.flatMap((entry) => entry.facets ?? []));
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

function archiveItemScope($: CheerioAPI, anchor: any) {
  const item = $(anchor).closest("li, article, tr, dd, dt").first();
  return item.length ? item : $(anchor).parent();
}

function archiveDate($: CheerioAPI, scope: ReturnType<CheerioAPI>): number | undefined {
  const dateNodes = scope.find("time[datetime], [data-published], [data-date], .archive-date, .date, [class*='date'], [class*='time']").toArray();
  for (const node of dateNodes) {
    const candidate = $(node).attr("datetime") || $(node).attr("data-published") || $(node).attr("data-date") || $(node).attr("content") || $(node).text();
    const parsed = parsePublishedAt(candidate);
    if (parsed !== undefined) return parsed;
  }
  return parsePublishedAt(scope.text());
}

/**
 * Archives commonly place tag/category links next to an article title and
 * date. Associate only declared taxonomy links from that same row; this
 * avoids guessing topics from a title, summary, or unrelated page navigation.
 */
function archiveEntryFacets($: CheerioAPI, scope: ReturnType<CheerioAPI>, pageUrl: string, articleAnchor: any): Facet[] {
  const page = assertPublicUrl(pageUrl);
  const values: Array<Facet | undefined> = [];
  for (const anchor of scope.find("a[href]").toArray()) {
    if (anchor === articleAnchor) continue;
    const rawUrl = toAbsoluteUrl($(anchor).attr("href"), pageUrl);
    const label = compactText($(anchor).text(), 120);
    if (!rawUrl || !label || !isArchiveTaxonomyAnchor($, anchor, rawUrl)) continue;
    let target: URL;
    try {
      target = assertPublicUrl(rawUrl);
    } catch {
      continue;
    }
    if (target.origin !== page.origin) continue;
    const kind = archiveFacetKind($, anchor, target);
    const key = archiveFacetKey(target, label);
    values.push(publisherFacet(pageUrl, kind, label, key));
  }
  return uniqueFacets(values);
}

function isArchiveTaxonomyAnchor($: CheerioAPI, anchor: any, rawUrl: string): boolean {
  const rel = ($(anchor).attr("rel") || "").toLowerCase();
  if (rel.split(/\s+/).includes("tag") || isTaxonomyUrl(rawUrl) || taxonomyPath(rawUrl)) return true;
  const className = `${$(anchor).attr("class") || ""} ${$(anchor).parent().attr("class") || ""}`;
  return /(?:^|[\s_-])(?:tag|tags|category|categories|taxonomy|topic|topics|label|labels)(?:$|[\s_-])/i.test(className);
}

function archiveFacetKind($: CheerioAPI, anchor: any, url: URL): "category" | "tag" {
  const rel = ($(anchor).attr("rel") || "").toLowerCase();
  if (rel.split(/\s+/).includes("tag")) return "tag";
  return /(?:^|\/)(?:tag|tags)(?:\/|$)/i.test(url.pathname) ? "tag" : "category";
}

function archiveFacetKey(url: URL, label: string): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const taxonomyIndex = segments.findIndex((segment) => /^(?:tag|tags|category|categories|taxonomy|topic|topics|label|labels)$/i.test(segment));
  const segment = taxonomyIndex >= 0 ? segments[taxonomyIndex + 1] : undefined;
  const fromPath = segment ? decodePathSegment(segment) : undefined;
  const fromQuery = ["tag", "tags", "category", "categories", "topic", "topics", "label", "labels"]
    .map((key) => url.searchParams.get(key))
    .find((value): value is string => Boolean(value));
  return canonicalFacetKey(fromPath ?? fromQuery ?? label) ?? label;
}

function taxonomyPath(rawUrl: string): boolean {
  try {
    return /(?:^|\/)(?:tag|tags|category|categories|taxonomy|topic|topics|label|labels)(?:\/|$)/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

function isArchiveTaxonomyUrl(rawUrl: string): boolean {
  return isTaxonomyUrl(rawUrl) || taxonomyPath(rawUrl);
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
      .replace(/\.(?:html?|php|xml)$/i, "")
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

function withFacets<T extends RawEntry>(entry: T, facets: Facet[]): T {
  return facets.length ? { ...entry, facets } : entry;
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
