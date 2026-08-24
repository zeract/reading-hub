import { load } from "cheerio";
import { compactText, parsePublishedAt } from "../shared/text";
import { isTaxonomyUrl, toAbsoluteUrl } from "../shared/url";
import type { CalibrationCandidate, ExtractionRule, RawEntry } from "../shared/types";

export interface ExtractionResult {
  title: string;
  entries: RawEntry[];
  rule?: ExtractionRule;
  confidence: number;
  fallback: boolean;
}

export function extractGenericPage(html: string, pageUrl: string, existingRule?: ExtractionRule): ExtractionResult {
  const $ = load(html);
  const pageTitle = compactText($("meta[property='og:title']").attr("content") || $("title").text(), 180) || new URL(pageUrl).hostname;
  const jsonLdEntries = extractJsonLd($, pageUrl);
  if (jsonLdEntries.length >= 1) {
    return { title: pageTitle, entries: jsonLdEntries, confidence: jsonLdEntries.length >= 2 ? 0.91 : 0.7, fallback: false };
  }

  if (existingRule?.itemRootSelector) {
    const entries = extractUsingRule($, pageUrl, existingRule);
    const detected = detectRepeatedItems($, pageUrl);
    if (shouldReplaceNarrowAutomaticRule(existingRule, entries, detected)) {
      return { title: pageTitle, ...detected, fallback: false };
    }
    if (entries.length) return { title: pageTitle, entries, rule: withAutomaticRuleRevision(existingRule), confidence: 0.88, fallback: false };
    const fallback = openGraphFallback($, pageUrl, pageTitle);
    return { title: pageTitle, entries: fallback ? [fallback] : [], confidence: fallback ? 0.2 : 0, fallback: true };
  }

  const detected = detectRepeatedItems($, pageUrl);
  if (detected.entries.length) return { title: pageTitle, ...detected, fallback: false };

  const fallback = openGraphFallback($, pageUrl, pageTitle);
  return { title: pageTitle, entries: fallback ? [fallback] : [], confidence: fallback ? 0.2 : 0, fallback: true };
}

/**
 * Early versions could save a narrow link-path rule (for example only
 * `/openstack/` posts on a blog archive). On later refreshes that rule used
 * to prevent the now-better detector from seeing the complete archive. A
 * calibrated rule has field-level selectors and is deliberately left alone;
 * only simple automatically-generated roots may self-heal.
 */
export const AUTOMATIC_RULE_REVISION = 3;
/**
 * Bump this only when the page-level publish-date parser gains a new safe
 * capability. Generic sources then make one unconditional request so entries
 * collected by an older parser can gain their real publication dates.
 */
export const PUBLICATION_DATE_REVISION = 2;

function withAutomaticRuleRevision(rule: ExtractionRule): ExtractionRule {
  return rule.autoRepairRevision === AUTOMATIC_RULE_REVISION ? rule : { ...rule, autoRepairRevision: AUTOMATIC_RULE_REVISION };
}

export function withPublicationDateRevision(rule?: ExtractionRule): ExtractionRule {
  const base = rule ?? { version: 1 };
  return base.publicationDateRevision === PUBLICATION_DATE_REVISION ? base : { ...base, publicationDateRevision: PUBLICATION_DATE_REVISION };
}

function shouldReplaceNarrowAutomaticRule(
  rule: ExtractionRule,
  current: RawEntry[],
  detected: Pick<ExtractionResult, "entries" | "rule" | "confidence">
): boolean {
  if (!detected.rule || detected.entries.length < 2 || detected.confidence < 0.7) return false;
  if (rule.rendererRequired || rule.titleSelector || rule.timeSelector || rule.authorSelector || rule.imageSelector || rule.summarySelector) return false;
  return detected.entries.length >= Math.max(current.length + 10, current.length * 2);
}

function extractJsonLd($: ReturnType<typeof load>, pageUrl: string): RawEntry[] {
  const nodes: any[] = [];
  $("script[type='application/ld+json']").each((_, node) => {
    const text = $(node).contents().text();
    try {
      const value = JSON.parse(text);
      visitJsonLd(value, nodes);
    } catch {
      // Bad JSON-LD is common; fall through to DOM extraction.
    }
  });
  const entries: RawEntry[] = [];
  for (const item of nodes) {
    const url = toAbsoluteUrl(item.url || item.mainEntityOfPage?.["@id"], pageUrl);
    const title = compactText(item.headline || item.name, 240);
    if (!url || !title) continue;
    entries.push({
      url,
      title,
      author: compactText(typeof item.author === "string" ? item.author : item.author?.name, 120),
      publishedAt: parsePublishedAt(item.datePublished || item.dateCreated),
      summary: compactText(item.description || item.articleBody, 500),
      imageUrl: toAbsoluteUrl(typeof item.image === "string" ? item.image : item.image?.url || item.thumbnailUrl, pageUrl)
    });
  }
  return entries;
}

function visitJsonLd(value: any, results: any[]): void {
  if (Array.isArray(value)) return value.forEach((child) => visitJsonLd(child, results));
  if (!value || typeof value !== "object") return;
  const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (type.some((kind: string) => ["Article", "NewsArticle", "BlogPosting", "VideoObject", "SocialMediaPosting"].includes(kind))) {
    results.push(value);
  }
  if (value["@graph"]) visitJsonLd(value["@graph"], results);
  if (value.itemListElement) visitJsonLd(value.itemListElement.map((item: any) => item.item || item), results);
}

type CandidateGroup = { label: string; rule: ExtractionRule; entries: RawEntry[]; score: number };

/** Produces human-readable candidates so people can repair a source without knowing CSS. */
export function extractCalibrationCandidates(html: string, pageUrl: string): CalibrationCandidate[] {
  const $ = load(html);
  // A new or deliberately sparse blog can legitimately have one published
  // card. It is still safe to offer it for *user-confirmed* calibration when
  // that card has strong article evidence; automatic probing continues to
  // require a repeated group to avoid mistaking page chrome for content.
  return collectCandidateGroups($, pageUrl, 1)
    .slice(0, 5)
    .map((candidate) => ({
      label: candidate.label,
      rule: candidate.rule,
      preview: candidate.entries.slice(0, 4),
      confidence: Math.min(0.98, 0.45 + Math.min(candidate.entries.length, 8) * 0.05 + Math.min(candidate.score, 3) * 0.08)
    }));
}

function detectRepeatedItems($: ReturnType<typeof load>, pageUrl: string): Pick<ExtractionResult, "entries" | "rule" | "confidence"> {
  const best = collectCandidateGroups($, pageUrl)[0];
  if (!best) return { entries: [], confidence: 0 };
  return {
    entries: best.entries,
    rule: best.rule,
    confidence: Math.min(0.89, 0.45 + Math.min(best.entries.length, 8) * 0.05 + Math.min(best.score, 3) * 0.08)
  };
}

function collectCandidateGroups($: ReturnType<typeof load>, pageUrl: string, minimumEntries = 2): CandidateGroup[] {
  const rawGroups = new Map<string, { label: string; nodes: any[] }>();
  const add = (selector: string, label: string, element: any) => {
    const group = rawGroups.get(selector) ?? { label, nodes: [] };
    group.nodes.push(element);
    rawGroups.set(selector, group);
  };

  for (const selector of ["article", "li", "[class]"]) {
    $(selector).each((_, element) => {
      if (isTaxonomyOrNavigation($, element)) return;
      if (selector === "[class]") {
        const className = ($(element).attr("class") || "").toLowerCase();
        if (!/(post|entry|article|story|card|item|feed|list|research)/.test(className)) return;
      }
      const stable = selector === "[class]" ? stableSelector($, element) : selector;
      if (stable) add(stable, selector === "article" ? "文章卡片" : selector === "li" ? "列表项目" : "页面内容卡片", element);
    });
  }

  const linkGroups = new Map<string, { label: string; nodes: any[] }>();
  $("a[href]").each((_, element) => {
    if (isTaxonomyOrNavigation($, element)) return;
    const href = $(element).attr("href");
    const absolute = toAbsoluteUrl(href, pageUrl);
    const text = compactText($(element).text(), 240);
    if (!absolute || isTaxonomyUrl(absolute) || !text || text.length < 18) return;
    try {
      const url = new URL(absolute);
      const page = new URL(pageUrl);
      if (url.origin !== page.origin) return;
      const firstSegment = url.pathname.split("/").filter(Boolean)[0];
      if (!firstSegment || !/^[a-z0-9_-]+$/i.test(firstSegment)) return;
      const selector = `a[href*="/${firstSegment}/"]`;
      const group = linkGroups.get(selector) ?? { label: `「/${firstSegment}/」文章链接`, nodes: [] };
      group.nodes.push(element);
      linkGroups.set(selector, group);
    } catch {
      // Invalid links are ignored; normal DOM candidates remain available.
    }
  });
  for (const [selector, group] of linkGroups) rawGroups.set(selector, group);

  const candidates: CandidateGroup[] = [];
  for (const [selector, group] of rawGroups) {
    // Archive-style blog homepages can legitimately contain hundreds of
    // dated posts. The former 100-item ceiling silently discarded exactly
    // those pages (for example Accela's complete archive).
    if (group.nodes.length < minimumEntries || group.nodes.length > 500) continue;
    const rule: ExtractionRule = { version: 1, autoRepairRevision: AUTOMATIC_RULE_REVISION, itemRootSelector: selector };
    const entries = uniqueEntries(
      group.nodes
        .slice(0, 500)
        .map((node) => entryFromElement($, node, pageUrl, rule))
        .filter((item): item is RawEntry => Boolean(item))
    );
    if (entries.length < minimumEntries) continue;
    const sampled = group.nodes.slice(0, 12);
    const score = sampled.reduce((sum, node) => sum + scoreItem($, node), 0) / sampled.length + Math.min(entries.length, 10) * 0.08;
    // A title-only link list is commonly a tag cloud or navigation. Require
    // article evidence (heading, summary, date, image, or sufficiently rich text)
    // before making it eligible for automatic extraction.
    // A one-item candidate is never auto-enabled; it must clear a higher
    // article-evidence threshold before being shown in the calibration UI.
    const threshold = entries.length === 1 ? 2.35 : 1.9;
    if (score >= threshold) candidates.push({
      label: `${group.label}（${entries.length} ${entries.length === 1 ? "篇，单篇监测" : "篇"}）`,
      rule,
      entries,
      score
    });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function uniqueEntries(entries: RawEntry[]): RawEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}

function stableSelector($: ReturnType<typeof load>, element: any): string | undefined {
  const tag = element.tagName || element.name;
  const classes = (($(element).attr("class") || "").split(/\s+/) as string[])
    .filter((name) => name && !/[0-9]{5,}/.test(name) && !name.includes("__"))
    .slice(0, 2)
    .map((name) => `.${cssEscape(name)}`);
  return classes.length ? `${tag}${classes.join("")}` : undefined;
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function scoreItem($: ReturnType<typeof load>, element: any): number {
  const root = $(element);
  const heading = root.is("h1,h2,h3,h4,h5,h6") ? root : root.find("h1,h2,h3,h4,h5,h6").filter((_, node) => Boolean(compactText($(node).text(), 240)?.length)).first();
  const headingLink = heading.find("a[href]").filter((_, node) => Boolean(compactText($(node).text(), 240)?.length)).first();
  const fallbackLink = root.is("a[href]") ? root : root.find("a[href]").filter((_, a) => Boolean(compactText($(a).text(), 240)?.length)).first();
  const link = root.is("a[href]") ? root : headingLink.length ? headingLink : fallbackLink;
  const title = compactText(heading.text() || link.text(), 240);
  const text = compactText(root.text(), 800) || "";
  const hasDate = Boolean(root.find("time,[datetime]").length || /(20\d{2}|\d{1,2}[月./-]\d{1,2})/.test(text));
  const hasSummary = Boolean(root.find("p,[class*='summary'],[class*='excerpt'],[class*='description']").filter((_, node) => (compactText($(node).text(), 500)?.length ?? 0) >= 40).length);
  return (title ? 0.9 : 0) + (link.attr("href") ? 0.6 : 0) + (heading.length ? 0.35 : 0) + (hasDate ? 0.4 : 0) + (root.find("img").length ? 0.2 : 0) + (hasSummary ? 0.35 : 0) + (text.length > 100 ? 0.25 : 0);
}

function extractUsingRule($: ReturnType<typeof load>, pageUrl: string, rule: ExtractionRule): RawEntry[] {
  return $(rule.itemRootSelector!)
    .toArray()
    .slice(0, 500)
    .map((element) => entryFromElement($, element, pageUrl, rule))
    .filter((item): item is RawEntry => Boolean(item));
}

function entryFromElement($: ReturnType<typeof load>, element: any, pageUrl: string, rule: ExtractionRule): RawEntry | undefined {
  const root = $(element);
  if (isTaxonomyOrNavigation($, element)) return undefined;
  const titleNode = rule.titleSelector
    ? findSelfOrDescendant(root, rule.titleSelector)
    : preferredTitleNode($, root);
  const titleLink = titleNode.find("a[href]").filter((_index: number, node: any) => Boolean(compactText($(node).text(), 240)?.length)).first();
  const fallbackLink = root.is("a[href]") ? root : root.find("a[href]").filter((_index: number, node: any) => Boolean(compactText($(node).text(), 240)?.length)).first();
  const linkNode = titleNode.is("a[href]") ? titleNode : titleLink.length ? titleLink : fallbackLink;
  const title = compactText(titleNode.text() || linkNode.text(), 240);
  const url = toAbsoluteUrl(linkNode.attr("href"), pageUrl);
  if (!title || !url || url === pageUrl || isTaxonomyUrl(url)) return undefined;
  const timeNode = rule.timeSelector ? root.find(rule.timeSelector).first() : root.find("time,[datetime]").first();
  const authorNode = rule.authorSelector ? root.find(rule.authorSelector).first() : root.find("[rel='author'],.author,[class*='author']").first();
  const imageNode = rule.imageSelector ? root.find(rule.imageSelector).first() : root.find("img").first();
  const summaryNode = rule.summarySelector ? root.find(rule.summarySelector).first() : preferredSummaryNode($, root, title);
  return {
    url,
    title,
    author: compactText(authorNode.text(), 120),
    // Cheerio's `.text()` concatenates adjacent card containers without a
    // separator (for example `sandboxJul 15, 2026`). `nodeDateValue` joins
    // direct children deliberately, preserving the date without weakening the
    // global text-date parser for ordinary prose.
    publishedAt: parsePublishedAt(timeNode.attr("datetime") || timeNode.text() || nodeDateValue($, root)),
    summary: compactText(summaryNode.text(), 500),
    imageUrl: toAbsoluteUrl(imageNode.attr("src") || imageNode.attr("data-src"), pageUrl)
  };
}

/**
 * Finds the publication date of one article document without treating dates
 * from an arbitrary body paragraph, related card, or footer as the article's
 * own date. The fallback is intentionally limited to the title's header.
 */
export function extractPagePublishedAt($: ReturnType<typeof load>): number | undefined {
  const structuredSelectors = [
    "meta[property='article:published_time']",
    "meta[property='og:published_time']",
    "meta[itemprop='datePublished']",
    "meta[name='datePublished']",
    "meta[name='publishdate']",
    "meta[name='date']",
    "meta[name='DC.date']",
    "meta[name='DC.Date']",
    "[itemprop='datePublished'][content]",
    "[data-published-at]",
    "[data-published]"
  ];
  for (const selector of structuredSelectors) {
    const date = parsePublishedAt(nodeDateValue($, $(selector).first()));
    if (date !== undefined) return date;
  }

  const structuredArticleDate = extractJsonLdArticleDate($);
  if (structuredArticleDate !== undefined) return structuredArticleDate;

  const title = $("h1").first();
  const titleHeader = title.closest("header");
  const articleHeader = title.closest("article").children("header").first();
  const dateScopes = [titleHeader, articleHeader].filter((scope, index, all) => scope.length && all.findIndex((candidate) => candidate.get(0) === scope.get(0)) === index);
  for (const scope of dateScopes) {
    for (const node of scope.find("time[datetime], time[dateTime]").toArray()) {
      const date = parsePublishedAt(nodeDateValue($, $(node)));
      if (date !== undefined) return date;
    }
    const dateLikeChildren = scope.find("[class], [id]").filter((_index, node) => {
      const identity = `${$(node).attr("class") || ""} ${$(node).attr("id") || ""}`;
      return /(date|publish|time|byline|metadata|post-meta|entry-meta|article-meta)/i.test(identity);
    });
    for (const node of dateLikeChildren.toArray()) {
      const date = parsePublishedAt(nodeDateValue($, $(node)));
      if (date !== undefined) return date;
    }
  }
  return undefined;
}

/**
 * An article's URL is a useful final metadata source when it carries a full
 * calendar date. This deliberately accepts only path segments, never loose
 * query text or a year-like version number in a title.
 */
export function extractPublicationDateFromUrl(rawUrl: string): number | undefined {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/(?:^|\/)(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?=$|[\/?#-])/);
    return match ? parsePublishedAt(`${match[1]}-${match[2]}-${match[3]}`) : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonLdArticleDate($: ReturnType<typeof load>): number | undefined {
  const nodes: any[] = [];
  $("script[type='application/ld+json']").each((_index, node) => {
    try {
      visitJsonLd(JSON.parse($(node).contents().text()), nodes);
    } catch {
      // Invalid JSON-LD is non-fatal and the header-specific fallbacks below
      // remain available.
    }
  });
  for (const item of nodes) {
    const date = parsePublishedAt(item.datePublished || item.dateCreated || item.uploadDate);
    if (date !== undefined) return date;
  }
  return undefined;
}

function nodeDateValue($: ReturnType<typeof load>, node: any): string | undefined {
  const childText = node.contents().toArray()
    .map((child: any) => compactText($(child).text(), 240))
    .filter((value: string | undefined): value is string => Boolean(value))
    .join(" ");
  return node.attr("content") || node.attr("datetime") || node.attr("dateTime") || node.attr("data-published-at") || node.attr("data-published") || compactText(childText || node.text(), 240);
}

function findSelfOrDescendant(root: any, selector: string) {
  return root.is(selector) ? root : root.find(selector).first();
}

function preferredTitleNode($: ReturnType<typeof load>, root: any) {
  if (root.is("h1,h2,h3,h4,h5,h6")) return root;
  const heading = root.find("h1,h2,h3,h4,h5,h6").filter((_index: number, node: any) => Boolean(compactText($(node).text(), 240)?.length)).first();
  if (heading.length) return heading;
  const labelledTitle = root.find("[data-title], [class*='title'], [class*='headline']").filter((_index: number, node: any) => {
    const identity = `${$(node).attr("data-title") || ""} ${$(node).attr("class") || ""}`;
    return /(?:^|[-_\s])(title|headline)(?:$|[-_\s])/i.test(identity)
      && Boolean(compactText($(node).text(), 240)?.length);
  }).first();
  if (labelledTitle.length) return labelledTitle;
  return root.is("a[href]") ? root : root.find("a[href]").filter((_index: number, node: any) => Boolean(compactText($(node).text(), 240)?.length)).first();
}

/**
 * Card layouts often put a short category or date in the first paragraph and
 * the actual excerpt later in the same linked card. Prefer explicit excerpt
 * fields, otherwise use the most substantial non-title paragraph. This keeps
 * generic whole-card links usable without a site-specific Framer rule.
 */
function preferredSummaryNode($: ReturnType<typeof load>, root: any, title: string) {
  const candidates: Array<{ node: any; text: string }> = root.find("[class*='summary'],[class*='excerpt'],[class*='description'],p").toArray()
    .map((node: any) => ({ node, text: compactText($(node).text(), 500) || "" }))
    .filter((candidate: { node: any; text: string }) => candidate.text.length >= 32 && candidate.text !== title);
  if (!candidates.length) return root.find("p").first();
  const semantic = candidates.filter(({ node }: { node: any; text: string }) => /summary|excerpt|description/i.test($(node).attr("class") || ""));
  const selected = (semantic.length ? semantic : candidates)
    .sort((left: { node: any; text: string }, right: { node: any; text: string }) => right.text.length - left.text.length)[0];
  return $(selected.node);
}

function isTaxonomyOrNavigation($: ReturnType<typeof load>, element: any): boolean {
  const root = $(element);
  if (root.is("nav, footer, aside, [role='navigation']") || root.parents("nav, footer, aside, [role='navigation']").length) return true;
  if (isCommentThreadContext($, root)) return true;
  const context = root.add(root.parents().slice(0, 3));
  return context.toArray().some((node: any) => /(?:^|[-_\s])(tag|tags|category|categories|taxonomy|menu|nav|breadcrumb|pagination|pager|footer|sidebar)(?:$|[-_\s])/i.test(`${$(node).attr("id") || ""} ${$(node).attr("class") || ""}`));
}

/**
 * Repeated-list discovery must not mistake a discussion thread for an article
 * archive. Normalise PascalCase component names first, so Scientific Spaces'
 * `ComListLi` and modern `CommentItem` containers receive the same treatment
 * as ordinary `.comment-list` markup without rejecting prose that merely
 * mentions the word “comment”.
 */
function isCommentThreadContext($: ReturnType<typeof load>, root: any): boolean {
  const context = root.add(root.parents());
  return context.toArray().some((node: any) => {
    const identity = `${$(node).attr("id") || ""} ${$(node).attr("class") || ""}`
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .toLowerCase();
    return /(?:^|\s)(?:comment(?:s|list|thread|item|content)?|com\s+list(?:\s+li)?|discussion|repl(?:y|ies))(?:$|\s)/.test(identity);
  });
}

function openGraphFallback($: ReturnType<typeof load>, pageUrl: string, title: string): RawEntry | undefined {
  const url = toAbsoluteUrl($("meta[property='og:url']").attr("content"), pageUrl) || pageUrl;
  const description = compactText($("meta[property='og:description'],meta[name='description']").first().attr("content"), 500);
  const imageUrl = toAbsoluteUrl($("meta[property='og:image']").attr("content"), pageUrl);
  return title ? { url, title, summary: description, imageUrl, publishedAt: extractPagePublishedAt($) } : undefined;
}
