import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { JSDOM, VirtualConsole } from "jsdom";
import katex from "katex";
import { compactText, parsePublishedAt } from "../shared/text";
import { inlineDollarMathAt } from "../shared/tex";
import { assertPublicUrl, canonicalizeUrl, isTrustedLoopbackFeedUrl, toAbsoluteUrl } from "../shared/url";
import type { Entry, ReaderArticle, ReaderFormulaDiagnostics, ReaderRenderProfile, Source } from "../shared/types";
import { parseFeed } from "./feed";
import { abortError, throwIfAborted } from "./cancellation";
import { PublicHttpClient, type PublicRequestOptions } from "./http";
import { extractPagePublishedAt } from "./extractor";
import { ScientificMathRenderer } from "./mathjax-renderer";
import type { PageRenderer } from "./page-renderer";
import { RobotsDisallowedError } from "./robots";

const CONTENT_SELECTORS = [
  { selector: "article", priority: 7 },
  { selector: "[itemprop='articleBody']", priority: 6 },
  { selector: ".article-content, .article-body, .entry-content, .post-content, .post-body", priority: 5 },
  { selector: ".RichContent-inner, .RichText", priority: 5 },
  { selector: "#content", priority: 4 },
  // Framer pages commonly expose their semantic section name in this
  // attribute, while leaving the article without an `article` element.
  { selector: "#main [data-framer-name]", priority: 2 },
  { selector: "#main", priority: 0 },
  // `main` is a last resort: many sites put navigation, lists and comments
  // alongside an article inside it.
  { selector: "main", priority: 0 }
];

// Zhihu answer/article pages often wrap their full page card in an `article`,
// while the actual authored prose lives in RichContent. Prefer the latter so
// response metadata and the discussion thread cannot outrank the body merely
// because `article` has a higher generic semantic priority.
const ZHIHU_CONTENT_SELECTORS = [
  // Zhihu columns use Post-RichTextContainer, while answers commonly use
  // RichContent-inner. Both are authored prose roots and must beat the wide
  // page-level article shell (which includes recommendations and comments).
  { selector: ".Post-RichTextContainer, .RichContent-inner, .RichText", priority: 12 },
  ...CONTENT_SELECTORS
];

const SCIENTIFIC_CONTENT_SELECTORS = [
  // Current Scientific Spaces pages place the article in this PascalCase
  // container. The surrounding `#content` also contains comments, payment
  // prompts and site chrome, so it must never win over the actual post root.
  { selector: "#PostContent, .PostContent", priority: 12 },
  { selector: "#post-body", priority: 10 },
  { selector: ".post-body, .post-content", priority: 9 },
  ...CONTENT_SELECTORS
];

const BASE_NOISE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "canvas",
  "svg",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "textarea",
  "[role='navigation']",
  "[role='banner']",
  "[class*='related']",
  "[class*='recommend']",
  "[class*='share']",
  "[class*='breadcrumb']",
  "[class*='post-meta']",
  "[class*='entry-meta']",
  "[class*='article-meta']",
  "[class*='advert']",
  "[class*='ad-']"
].join(",");

// Some providers use PascalCase discussion components, which are not matched
// by the generic lower-case class selector below. Keep these explicit so an
// answer's CommentList/CommentItem cannot leak into a selected article root.
const COMMENT_THREAD_SELECTOR = [
  "#comment", "#comments", "#comment-list", "#commentlist",
  ".comments", ".comment-list", ".commentlist", ".comment-thread", ".comments-area", ".comment-section",
  "[class*='CommentList']", "[class*='CommentItem']", "[class*='CommentContent']", "[class*='CommentLink']", "[class*='CommentsV2']",
  "[class$='-comments']", "[class$='_comments']", "[class*='comment-list']", "[class*='comment-thread']", "[class*='comments-area']"
].join(",");

const NOISE_SELECTOR = [BASE_NOISE_SELECTOR, "[class*='comment']", COMMENT_THREAD_SELECTOR].join(",");

const ZHIHU_INLINE_ANNOTATION_TAGS = new Set([
  "a", "b", "del", "em", "i", "ins", "mark", "s", "small", "span", "strong", "sub", "sup"
]);

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "kbd", "li", "mark", "ol", "p", "picture", "pre", "s", "small", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"
]);

const ARTICLE_CHROME_SELECTOR = [
  ".post-header", ".entry-header", ".article-header", ".post-title", ".entry-title", ".breadcrumb", ".breadcrumbs",
  "[class*='breadcrumb']", "[class*='post-meta']", "[class*='entry-meta']", "[class*='article-meta']",
  ".post-footer", ".entry-footer", ".article-footer", "[class*='post-footer']", "[class*='entry-footer']", "[class*='article-footer']"
].join(",");

// Scientific Spaces puts its discussion thread inside the same `#content`
// wrapper as the article. Its comment components deliberately use PascalCase
// class names, which are not caught by the generic lower-case comment noise
// rule. Keep this source-specific and exact so ordinary
// pages retain any author-provided content that happens to discuss comments.
const SCIENTIFIC_DISCUSSION_SELECTOR = [
  "#comments", "#PostComment", "#MobileComments",
  ".AllComments", ".ComListLi", ".block-comment",
  "[id^='comment-']", "[id^='respond-post-']"
].join(", ");

// These are Scientific Spaces' article-adjacent widgets, not author prose.
// They matter only when an older page shell forces the reader to use the
// broad `#content` fallback instead of the dedicated post container above.
const SCIENTIFIC_AUXILIARY_SELECTOR = "#content_tips, #pay, #how_to_cite";

type FormulaOrigin = "semantic" | "mathjax-script" | "mathjax-frame" | "text";
type FormulaRecord = { token: string; tex: string; displayMode: boolean; origin: FormulaOrigin };
type SanitizedContent = { html: string; formulaDiagnostics: ReaderFormulaDiagnostics };

/**
 * FormulaDocument is the single semantic boundary between an untrusted page
 * DOM and the reader's renderers. Every supported source form is reduced to
 * a record before noise removal or attribute sanitisation can erase its TeX.
 */
class FormulaDocument {
  readonly records: FormulaRecord[] = [];

  add(tex: string, displayMode: boolean, origin: FormulaOrigin): string {
    const token = `${MATH_TOKEN_PREFIX}${this.records.length}${MATH_TOKEN_SUFFIX}`;
    this.records.push({ token, tex: tex.trim(), displayMode, origin });
    return token;
  }

  get(index: number): FormulaRecord | undefined {
    return this.records[index];
  }

  diagnostics(rendered: number, fallback: number, dropped: number): ReaderFormulaDiagnostics {
    const count = (origin: FormulaOrigin) => this.records.filter((record) => record.origin === origin).length;
    return {
      total: this.records.length,
      semantic: count("semantic"),
      mathJaxScript: count("mathjax-script"),
      mathJaxFrame: count("mathjax-frame"),
      text: count("text"),
      rendered,
      fallback,
      dropped
    };
  }
}
type ContentCandidate = {
  html: string;
  quality: number;
  priority: number;
  title?: string;
  author?: string;
  publishedAt?: number;
};
const MATH_TOKEN_PREFIX = "[[READING_HUB_MATH_";
const MATH_TOKEN_SUFFIX = "]]";

export class ArticleContentUnavailableError extends Error {
  constructor() {
    super("这个网页没有提供可在应用内显示的正文。你仍可使用“在浏览器打开”查看原文。");
    this.name = "ArticleContentUnavailableError";
  }
}

export interface ReaderReadOptions {
  /** Optional audit-only cancellation. Normal renderer IPC requests omit it. */
  signal?: AbortSignal;
}

type RenderWithSession = (url: string, options?: ReaderReadOptions) => Promise<string>;
type ExtractedArticle = { article: ReaderArticle; textLength: number };

function resolveReaderProfile(pageUrl: string): ReaderRenderProfile {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    return host === "kexue.fm" || host.endsWith(".kexue.fm") ? "scientific" : "standard";
  } catch {
    return "standard";
  }
}

/**
 * MathJax configuration is normally placed in the page head, outside the
 * article wrapper. Read only its TeX declarations before sanitisation; the
 * script itself never reaches the renderer and is never executed.
 */
function collectGlobalMathDeclarations($: ReturnType<typeof load>): string {
  const declarations: string[] = [];
  $("script").each((_index: number, node: any) => {
    const script = $(node);
    const type = (script.attr("type") || "").toLowerCase();
    const text = script.html() || script.text() || "";
    if (!text.trim()) return;
    if (type.includes("mathjax") || /\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator|(?:g|e|x)?def)\b|(?:TeX|tex)\s*:\s*\{|(?:Macros|macros)\s*:\s*\{/i.test(text)) {
      declarations.push(text);
    }
  });
  return declarations.join("\n");
}

/**
 * Fetches an article only when it is opened. The resulting HTML is sanitised in
 * the main process and never persisted, so remote documents cannot run code in
 * the React renderer or become an on-disk full-text archive.
 */
export class ArticleReader {
  constructor(
    private readonly http: PublicHttpClient,
    private readonly renderer: PageRenderer,
    private readonly renderWithZhihuSession?: RenderWithSession,
    private readonly scientificMath = new ScientificMathRenderer()
  ) {}

  async read(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle> {
    throwIfAborted(options?.signal);
    let staticArticle: ExtractedArticle | undefined;
    let staticFailure: unknown;
    const usesZhihuSession = source?.kind === "zhihu_follow" && Boolean(this.renderWithZhihuSession);
    if (resolveReaderProfile(entry.url) === "scientific") await this.scientificMath.ready().catch(() => undefined);
    throwIfAborted(options?.signal);
    if (!usesZhihuSession) {
      try {
        const response = await this.http.getText(entry.url, undefined, readerHttpOptions({ maxBytes: 8_000_000 }, options?.signal));
        staticArticle = await this.extractWithMathFallback(response.text, response.url, entry);
        if (staticArticle && staticArticle.textLength >= 220) return staticArticle.article;
      } catch (error) {
        if (options?.signal?.aborted) throw abortError(options.signal);
        // robots.txt must remain a hard boundary. A feed can nevertheless
        // already contain an explicitly supplied summary, which is local
        // subscription data rather than an extraction of the blocked page.
        // This makes RSSHub/X items readable without trying to fetch X again.
        if (error instanceof RobotsDisallowedError) {
          const feedBody = await this.readTransientFeedBody(entry, source, options).catch(() => {
            if (options?.signal?.aborted) throw abortError(options.signal);
            return undefined;
          });
          if (feedBody) return feedBody;
          const feedSummary = createFeedSummaryArticle(entry, source);
          if (feedSummary) return feedSummary;
          throw error;
        }
        staticFailure = error;
      }
    }

    let renderedHtml: string | undefined;
    try {
      renderedHtml = usesZhihuSession && this.renderWithZhihuSession
        ? await this.renderWithZhihuSession(entry.url, options)
        : await this.renderer.render(entry.url, options);
    } catch (error) {
      if (options?.signal?.aborted) throw abortError(options.signal);
      // Keep a usable static article when Chromium rendering is unavailable.
    }
    throwIfAborted(options?.signal);
    const renderedArticle = renderedHtml ? await this.extractWithMathFallback(renderedHtml, entry.url, entry) : undefined;
    if (renderedArticle && renderedArticle.textLength > (staticArticle?.textLength ?? 0)) return renderedArticle.article;
    if (staticArticle) return staticArticle.article;
    // A public original can intermittently reject a reader request (or time
    // out) even though its RSS response already supplied a body. That body is
    // part of the user's subscription, so re-fetch and sanitise it in memory
    // before surfacing an avoidable read error. This never retries a blocked
    // original page and never persists full Feed content.
    const feedBody = await this.readTransientFeedBody(entry, source, options).catch(() => {
      if (options?.signal?.aborted) throw abortError(options.signal);
      return undefined;
    });
    if (feedBody) return feedBody;
    const feedSummary = createFeedSummaryArticle(entry, source);
    if (feedSummary) return feedSummary;
    if (staticFailure) throw staticFailure;
    throw new ArticleContentUnavailableError();
  }

  /**
   * A Feed body is an explicit part of the subscription response, not a
   * request to the linked article. Re-read it only when the user opens a
   * blocked item, sanitize it in this process, and discard it with the
   * ReaderArticle. SQLite never receives feedContentHtml.
   */
  private async readTransientFeedBody(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle | undefined> {
    throwIfAborted(options?.signal);
    if (source?.kind !== "rss") return undefined;
    const allowTrustedLoopbackFeed = source.config?.allowTrustedLoopbackFeed === true && isTrustedLoopbackFeedUrl(source.url);
    const response = await this.http.getText(
      source.url,
      undefined,
      allowTrustedLoopbackFeed
        ? readerHttpOptions({ allowTrustedLoopbackFeed: true }, options?.signal)
        : readerHttpOptions(undefined, options?.signal)
    );
    throwIfAborted(options?.signal);
    const requestedUrls = new Set([entry.canonicalUrl, canonicalizeUrl(entry.url)]);
    const item = (await parseFeed(response.text, response.url)).entries.find((candidate) => {
      try {
        return requestedUrls.has(canonicalizeUrl(candidate.url));
      } catch {
        return false;
      }
    });
    if (!item?.feedContentHtml) return undefined;

    const renderProfile = resolveReaderProfile(entry.url);
    let sanitised = sanitizeContent(item.feedContentHtml, response.url, this.scientificMath, "");
    if (needsMathJaxFallback(sanitised) && !this.scientificMath.isReady()) {
      await this.scientificMath.ready().catch(() => undefined);
      if (this.scientificMath.isReady()) sanitised = sanitizeContent(item.feedContentHtml, response.url, this.scientificMath, "");
    }
    const contentHtml = sanitised.html;
    const content = load(contentHtml);
    if (normalText(content.text()).length < 24 && !content("img").length) return undefined;
    const coverCandidate = safeUrl(entry.imageUrl, response.url);
    return {
      entryId: entry.id,
      url: entry.url,
      title: entry.title,
      author: entry.author,
      publishedAt: entry.publishedAt,
      coverImageUrl: coverCandidate && !containsImage(contentHtml, coverCandidate) ? coverCandidate : undefined,
      renderProfile,
      contentMode: "feed_body",
      formulaDiagnostics: sanitised.formulaDiagnostics,
      contentHtml
    };
  }

  /**
   * Formula compatibility follows the document's semantic payload, not the
   * host name. KaTeX remains the fast first pass; only an actual fallback
   * record starts the local MathJax SVG runtime and replays the same inert
   * extraction. This lets a Zhihu reprint of a scientific article use the
   * exact same safe fallback as its original site without eagerly loading
   * MathJax for ordinary articles.
   */
  private async extractWithMathFallback(html: string, pageUrl: string, entry: Entry): Promise<ExtractedArticle | undefined> {
    let extracted = extractReaderArticle(html, pageUrl, entry, this.scientificMath);
    if (!extracted || !needsMathJaxFallback(extracted.article) || this.scientificMath.isReady()) return extracted;
    await this.scientificMath.ready().catch(() => undefined);
    if (this.scientificMath.isReady()) extracted = extractReaderArticle(html, pageUrl, entry, this.scientificMath);
    return extracted;
  }
}

function readerHttpOptions(base: Omit<PublicRequestOptions, "signal"> | undefined, signal?: AbortSignal): PublicRequestOptions | undefined {
  return signal ? { ...base, signal } : base;
}

/**
 * Keeps a useful in-app reading path for feeds whose links point to a page
 * that forbids automated article retrieval. This intentionally only renders
 * the normalised, bounded summary already saved for an RSS/X subscription;
 * it never reaches back to the blocked origin or treats the summary as a full
 * article.
 */
function createFeedSummaryArticle(entry: Entry, source?: Source): ReaderArticle | undefined {
  const rawSummary = entry.summary;
  if ((source?.kind !== "rss" && source?.kind !== "x") || !rawSummary) return undefined;
  const summary = compactText(rawSummary, 500) || "";
  if (summary.length < 24) return undefined;
  return {
    entryId: entry.id,
    url: entry.url,
    title: entry.title,
    author: entry.author,
    publishedAt: entry.publishedAt,
    coverImageUrl: entry.imageUrl,
    renderProfile: "standard",
    contentMode: "feed_summary",
    contentHtml: `<p>${escapeHtml(summary)}</p>`
  };
}

/** Exported for deterministic extraction tests; it does not perform network requests. */
export function extractReaderArticle(html: string, pageUrl: string, entry: Entry, scientificMath?: ScientificMathRenderer): ExtractedArticle | undefined {
  const $ = load(html);
  const renderProfile = resolveReaderProfile(pageUrl);
  const content = chooseContentCandidate(pickContentRoot($, renderProfile, pageUrl), extractReadabilityContent(html, pageUrl));
  if (!content) return undefined;
  const contentDocument = load(`<article id="reader-selected-content">${content.html}</article>`);
  const selectedContent = contentDocument("#reader-selected-content");
  const title = normalText(
    $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      content.title ||
      $("h1").first().text() ||
      entry.title
  ) || entry.title;
  removeNoiseExceptMathScripts(contentDocument, selectedContent, pageUrl);
  selectedContent.find("header").remove();
  removeDuplicateArticleChrome(contentDocument, selectedContent, title, renderProfile, entry.summary);

  const sanitised = sanitizeContent(selectedContent.html() || "", pageUrl, scientificMath, collectGlobalMathDeclarations($));
  const contentHtml = sanitised.html;
  const textLength = normalText(load(contentHtml).text()).length;
  if (!textLength) return undefined;

  const author = compactText(
    $("meta[name='author']").attr("content") ||
      $("[rel='author'], [class*='author']").first().text() ||
      content.author ||
      entry.author,
    160
  );
  const publishedAt = extractPagePublishedAt($) || content.publishedAt || entry.publishedAt;
  const coverCandidate = safeUrl(
    $("meta[property='og:image'], meta[name='twitter:image']").first().attr("content") || entry.imageUrl,
    pageUrl
  );
  // An Open Graph image is often also the article's first figure. Rendering it
  // once as a cover and once in the preserved body creates an artificial
  // duplicate, so the body remains the single source of truth in that case.
  const coverImageUrl = coverCandidate && !containsImage(contentHtml, coverCandidate) ? coverCandidate : undefined;

  return {
    article: {
      entryId: entry.id,
      url: entry.url,
      title,
      author,
      publishedAt,
      coverImageUrl,
      renderProfile,
      formulaDiagnostics: sanitised.formulaDiagnostics,
      contentHtml
    },
    textLength
  };
}

function removeNoiseExceptMathScripts($: ReturnType<typeof load>, content: any, pageUrl: string): void {
  preserveZhihuInlineAnnotations($, content, pageUrl);
  content.find(NOISE_SELECTOR).each((_index: number, node: any) => {
    const element = $(node);
    if (isMathScript(element) || isImageNoscript(element)) return;
    element.remove();
  });
}

function isImageNoscript(element: any): boolean {
  if (element.get(0)?.tagName?.toLowerCase() !== "noscript") return false;
  const fallback = load(element.text() || element.html() || "", {}, false);
  return fallback("img").length > 0;
}

function removeDuplicateArticleChrome(
  $: ReturnType<typeof load>,
  content: any,
  title: string,
  renderProfile: ReaderRenderProfile,
  entrySummary?: string
): void {
  content.find(ARTICLE_CHROME_SELECTOR).remove();
  content.find("h1,h2,h3,h4,h5,h6").find("a.headerlink,a[href^='#']").remove();
  content.find("h1, h2, h3").each((_index: number, node: any) => {
    if (normalText($(node).text()) === title) $(node).remove();
  });
  content.find("p").each((_index: number, node: any) => {
    const text = normalText($(node).text());
    if (/^by\s+.+\|\s*\d{4}-\d{2}-\d{2}\s*\|/i.test(text)) $(node).remove();
  });
  if (renderProfile === "scientific") {
    // The source's static `#content` tree includes reader comments. Remove
    // them before formula preservation so a comment's malformed/split TeX
    // cannot be mistaken for article content or corrupt reader diagnostics.
    content.find(SCIENTIFIC_DISCUSSION_SELECTOR).remove();
    content.find(SCIENTIFIC_AUXILIARY_SELECTOR).remove();
    removeScientificSpacesChrome($, content, entrySummary);
  }
}

/**
 * Scientific Spaces has varied between several page shells. The clean article
 * paragraph is reflected in the feed summary, while the leading shell carries
 * section links, title/date and author metadata. Trim every preceding sibling
 * along the paragraph's ancestor path so it works both for the old flat shell
 * and newer nested page layouts without depending on a brittle theme class.
 */
function removeScientificSpacesChrome($: ReturnType<typeof load>, content: any, entrySummary?: string): void {
  const lead = normalText(entrySummary || "").slice(0, 28);
  if (lead.length < 12) return;
  const firstBodyNode = content.find("p, div, section, article").toArray()
    .filter((node: any) => normalText($(node).text()).includes(lead))
    .sort((left: any, right: any) => normalText($(left).text()).length - normalText($(right).text()).length)[0];
  if (!firstBodyNode) return;
  let cursor = $(firstBodyNode);
  while (cursor.length && cursor.get(0) !== content.get(0)) {
    const parent = cursor.parent();
    if (!parent.length) break;
    for (const sibling of parent.children().toArray()) {
      if (sibling === cursor.get(0)) break;
      $(sibling).remove();
    }
    cursor = parent;
  }
}

function pickContentRoot($: ReturnType<typeof load>, profile: ReaderRenderProfile, pageUrl: string): ContentCandidate | undefined {
  const prefersZhihuRichContent = isZhihuContentUrl(pageUrl);
  const candidates = new Map<any, number>();
  const selectors = profile === "scientific"
    ? SCIENTIFIC_CONTENT_SELECTORS
    : prefersZhihuRichContent
      ? ZHIHU_CONTENT_SELECTORS
      : CONTENT_SELECTORS;
  for (const { selector, priority } of selectors) {
    $(selector).each((_index, node) => {
      candidates.set(node, Math.max(candidates.get(node) || 0, priority));
    });
  }
  if (!candidates.size) candidates.set($("body").get(0), -1);

  let best: { node: any; score: number; priority: number } | undefined;
  for (const [node, priority] of candidates) {
    if (!node) continue;
    const candidate = $(node).clone();
    preserveZhihuInlineAnnotations($, candidate, pageUrl);
    candidate.find(NOISE_SELECTOR).remove();
    const text = normalText(candidate.text());
    if (text.length < 40) continue;
    const paragraphCount = candidate.find("p, li, blockquote, pre").length;
    const imageCount = candidate.find("img").length;
    const linkCount = candidate.find("a[href]").length;
    const score = Math.min(text.length, 18_000) + paragraphCount * 140 + imageCount * 90 - linkCount * 18;
    // A coherent semantic article must beat a page-sized main container even
    // when the latter contains much more sidebar and comment text.
    if (!best || priority > best.priority || (priority === best.priority && score > best.score)) {
      best = { node, score, priority };
    }
  }
  if (!best) return undefined;
  const root = $(best.node).clone();
  return { html: root.html() || "", quality: readerContentQuality(root), priority: best.priority };
}

function isZhihuContentUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "zhihu.com" || host.endsWith(".zhihu.com");
  } catch {
    return false;
  }
}

/**
 * Zhihu may wrap selected authored text in an inline marker when readers have
 * commented on that passage. The generic noise rule deliberately removes
 * comment *threads*, so normalize only inline wording wrappers before it runs.
 *
 * Remove only the comment/annotation class token rather than the element or
 * its entire class list. This retains normal text semantics and essential
 * semantic carriers such as Zhihu's `ztext-math` / `ztext-math-block`, while
 * the sanitizer still strips all remote presentation classes later.
 * Block-level CommentList/CommentItem ancestors are deliberately left intact
 * here and removed by COMMENT_THREAD_SELECTOR.
 */
function preserveZhihuInlineAnnotations($: ReturnType<typeof load>, content: any, pageUrl: string): void {
  if (!isZhihuContentUrl(pageUrl)) return;
  content.find("[class]").each((_index: number, node: any) => {
    const element = $(node);
    const tagName = element.get(0)?.tagName?.toLowerCase();
    const className = element.attr("class") || "";
    // `commented` is a passage annotation; labels such as CommentLink and
    // comment-link are interaction controls and must remain removable noise.
    if (!tagName || !ZHIHU_INLINE_ANNOTATION_TAGS.has(tagName) || !/(?:commented|annotation)/i.test(className)) return;
    if (element.is(COMMENT_THREAD_SELECTOR) || element.parents(COMMENT_THREAD_SELECTOR).length) return;
    const retainedClasses = className
      .split(/\s+/)
      .filter((classToken) => classToken && !/(?:commented|annotation)/i.test(classToken));
    if (retainedClasses.length) element.attr("class", retainedClasses.join(" "));
    else element.removeAttr("class");
  });
}

/**
 * Firefox Reader View's extraction is a useful second opinion when a site has
 * no semantic article wrapper or mixes navigation into its main container.
 * Its result is still passed through the local sanitizer below.
 */
function extractReadabilityContent(html: string, pageUrl: string): ContentCandidate | undefined {
  let document: JSDOM | undefined;
  try {
    // Readability does not need a page's stylesheet.  Keep jsdom's parser
    // diagnostics local as third-party CSS can be intentionally partial or
    // use unsupported syntax; otherwise ordinary articles create noisy
    // "Could not parse CSS stylesheet" warnings in Electron's console.
    document = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() });
    const parsed = new Readability(document.window.document, { charThreshold: 140, keepClasses: true }).parse();
    const content = parsed?.content || "";
    const text = normalText(parsed?.textContent || "");
    if (!content || text.length < 140) return undefined;
    const $ = load(`<article id="reader-readability-content">${content}</article>`);
    const root = $("#reader-readability-content");
    return {
      html: content,
      quality: readerContentQuality(root),
      priority: 3,
      title: compactText(parsed?.title || undefined, 240),
      author: compactText(parsed?.byline || undefined, 160),
      publishedAt: parsePublishedAt(parsed?.publishedTime || undefined)
    };
  } catch {
    return undefined;
  } finally {
    document?.window.close();
  }
}

function chooseContentCandidate(semantic: ContentCandidate | undefined, readable: ContentCandidate | undefined): ContentCandidate | undefined {
  if (!semantic) return readable;
  if (!readable) return semantic;
  // Explicit article containers tend to preserve the author's Markdown and
  // code structure. For loose main/content shells, prefer Reader View when
  // it improves the text/link-density quality materially.
  if (semantic.priority >= 2 && semantic.quality >= readable.quality * 0.72) return semantic;
  return readable.quality >= semantic.quality * 0.92 ? readable : semantic;
}

function readerContentQuality(root: any): number {
  const text = normalText(root.text());
  const linkText = normalText(root.find("a[href]").text());
  const linkDensity = text.length ? linkText.length / text.length : 1;
  const blocks = root.find("p, li, blockquote, pre, table, figure").length;
  const headings = root.find("h1,h2,h3,h4").length;
  const media = root.find("img, pre, table, figure").length;
  return Math.min(text.length, 18_000) + blocks * 120 + headings * 90 + media * 70 - Math.round(linkDensity * Math.min(text.length, 12_000) * 0.7);
}

function sanitizeContent(
  rawHtml: string,
  pageUrl: string,
  scientificMath: ScientificMathRenderer | undefined,
  globalMathDeclarations: string
): SanitizedContent {
  const $ = load(`<div id="reader-content">${rawHtml}</div>`);
  const root = $("#reader-content");
  hydrateLazyImages($, root, pageUrl);
  preserveZhihuInlineAnnotations($, root, pageUrl);
  const formulas = new FormulaDocument();
  // Semantic containers must be consumed first. In particular, Zhihu wraps
  // `data-tex` around a MathJax SVG visual copy; looking at the child frame
  // first loses the only source TeX when generic sanitisation removes data/SVG.
  preserveSemanticFormulaCarriers($, root, formulas);
  preserveMathScripts($, root, formulas);
  preserveRenderedMathJax($, root, formulas);
  root.find(NOISE_SELECTOR).remove();
  for (const node of root.find("*").toArray()) {
    const element = $(node);
    const tag = (node as any).tagName?.toLowerCase();
    if (!tag) continue;
    if (tag === "input") {
      if ((element.attr("type") || "").toLowerCase() === "checkbox") {
        element.replaceWith($("<span>").text(element.is("[checked]") ? "☑ " : "☐ "));
      } else {
        element.remove();
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(element.contents());
      continue;
    }
    if (tag === "img") {
      const src = imageSource(element, pageUrl);
      const alt = normalText(element.attr("alt") || "");
      removeAllAttributes(element);
      if (!src) {
        element.remove();
        continue;
      }
      element.attr("src", src);
      if (alt) element.attr("alt", alt);
      element.attr("loading", "lazy");
      element.attr("data-reader-zoomable", "true");
      element.attr("tabindex", "0");
      element.attr("role", "button");
      element.attr("aria-label", alt ? `放大图片：${alt}` : "放大图片");
      continue;
    }
    if (tag === "details") {
      removeAllAttributes(element);
      // Reader View is intended to make content available without requiring
      // JavaScript, so expanded Markdown details are less surprising here.
      element.attr("open", "");
      continue;
    }
    if (tag === "a") {
      const href = safeUrl(element.attr("href"), pageUrl);
      const label = normalText(element.text());
      // An image-only link is a common figure pattern (notably in Substack
      // posts). Calling `text(href)` on it would replace the nested picture
      // and image nodes with the URL itself, silently removing the figure.
      // Only synthesize a visible label for a genuinely empty anchor.
      const hasContents = element.contents().length > 0;
      removeAllAttributes(element);
      if (!href) {
        element.replaceWith(element.contents());
        continue;
      }
      element.attr("href", href);
      if (!label && !hasContents) element.text(href);
      continue;
    }
    removeAllAttributes(element);
  }
  preserveTextMath($, root, formulas);
  normaliseTeXCitationLinks($, root, pageUrl);
  return renderMath(root.html() || "", formulas, scientificMath, globalMathDeclarations);
}

/**
 * Some scientific bibliographies use lightweight TeX link commands directly
 * in HTML prose. They are not math and should become ordinary safe links,
 * rather than leaking a `\\url{…}` command into the reader.
 */
function normaliseTeXCitationLinks($: ReturnType<typeof load>, root: any, pageUrl: string): void {
  const citation = /\\(?:url\{([^}\s]+)\}|href\{([^}\s]+)\}\{([^}]*)\})/g;
  const visit = (node: any, insideLiteral = false): void => {
    const tag = node.tagName?.toLowerCase();
    const literal = insideLiteral || tag === "code" || tag === "pre";
    for (const child of [...(node.children || [])]) {
      if (child.type === "text" && !literal) {
        const text = child.data || "";
        if (!citation.test(text)) continue;
        citation.lastIndex = 0;
        let cursor = 0;
        let result = "";
        let match: RegExpExecArray | null;
        while ((match = citation.exec(text))) {
          result += escapeHtml(text.slice(cursor, match.index));
          const href = safeUrl(match[1] || match[2], pageUrl);
          const label = normalText(match[3] || href || "");
          result += href ? `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>` : escapeHtml(match[0]);
          cursor = citation.lastIndex;
        }
        result += escapeHtml(text.slice(cursor));
        $(child).replaceWith(result);
      } else if (child.type === "tag") {
        visit(child, literal);
      }
    }
  };
  visit(root.get(0));
}

/** Hydrates common lazy-image and <picture> patterns before stripping markup. */
function hydrateLazyImages($: ReturnType<typeof load>, root: any, pageUrl: string): void {
  root.find("picture").each((_index: number, node: any) => {
    const picture = $(node);
    const image = picture.find("img").first();
    const source = picture.find("source").toArray().map((item: any) => $(item).attr("data-srcset") || $(item).attr("srcset")).find(Boolean);
    if (image.length && source && !image.attr("data-reader-picture-srcset")) image.attr("data-reader-picture-srcset", source);
  });

  root.find("noscript").each((_index: number, node: any) => {
    const fallback = load($(node).text() || $(node).html() || "", {}, false);
    const fallbackImage = fallback("img").first();
    if (!fallbackImage.length) return;
    const previousImage = $(node).prev("img");
    const fallbackSrc = imageSource(fallbackImage, pageUrl);
    const equivalentSibling = $(node).siblings("img").toArray().map((sibling: any) => $(sibling)).find((image: any) => {
      const siblingSrc = imageSource(image, pageUrl);
      return sameImageAsset(fallbackSrc, siblingSrc);
    });
    // WordPress's lightbox block places a static <noscript> image immediately
    // before its lazy image sibling. They can resolve to different generated
    // sizes of one asset, so retaining both creates two visible figures.
    if (equivalentSibling) {
      const alt = normalText(fallbackImage.attr("alt") || "");
      if (alt && !normalText(equivalentSibling.attr("alt") || "")) equivalentSibling.attr("alt", alt);
      $(node).remove();
      return;
    }
    if (previousImage.length) {
      if (fallbackSrc && !imageSource(previousImage, pageUrl)) previousImage.attr("data-reader-noscript-src", fallbackSrc);
      const srcset = fallbackImage.attr("data-srcset") || fallbackImage.attr("srcset");
      if (srcset && !previousImage.attr("data-reader-noscript-srcset")) previousImage.attr("data-reader-noscript-srcset", srcset);
      // The fallback has now been merged into the preceding lazy image. It
      // must not survive the sanitizer as a second visible <img>.
      $(node).remove();
      return;
    }
    if (!fallbackSrc) return;
    const image = $("<img>");
    image.attr("src", fallbackSrc);
    const alt = normalText(fallbackImage.attr("alt") || "");
    if (alt) image.attr("alt", alt);
    $(node).replaceWith(image);
  });
  removeLocalDuplicateImages($, root, pageUrl);
}

/**
 * A source can contain both an accessible fallback and a client-side image in
 * one figure. Dedupe only inside one media container (or direct siblings), so
 * an author can still intentionally use the same illustration in two separate
 * figures elsewhere in the article.
 */
function removeLocalDuplicateImages($: ReturnType<typeof load>, root: any, pageUrl: string): void {
  root.find("figure, picture").each((_index: number, node: any) => removeDuplicateImagesIn($, $(node), pageUrl));
  root.children().each((_index: number, node: any) => {
    const container = $(node);
    if (container.is("figure, picture")) return;
    const images = container.children("img");
    if (images.length > 1) removeDuplicateImagesIn($, container, pageUrl, true);
  });
}

function removeDuplicateImagesIn($: ReturnType<typeof load>, container: any, pageUrl: string, directOnly = false): void {
  const seen = new Set<string>();
  const images = directOnly ? container.children("img").toArray() : container.find("img").toArray();
  for (const node of images) {
    const image = $(node);
    const src = imageSource(image, pageUrl);
    const key = imageAssetKey(src);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    const parentLink = image.parent("a");
    image.remove();
    if (parentLink.length && !parentLink.find("img").length && !normalText(parentLink.text())) parentLink.remove();
  }
}

function containsImage(contentHtml: string, imageUrl: string): boolean {
  const content = load(`<div>${contentHtml}</div>`);
  const target = imageAssetKey(imageUrl);
  return content("img").toArray().some((node) => imageAssetKey(content(node).attr("src")) === target);
}

function imageUrlKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * A CMS commonly emits the same original image in several generated sizes,
 * for example `Figure1.png` and `Figure1-625x125.png`. These are one visual
 * asset when they coexist in a single article image block. Keep the exact URL
 * for rendering, but compare their stable asset identity for deduplication.
 */
function imageAssetKey(value: string | undefined): string | undefined {
  const key = imageUrlKey(value);
  if (!key) return undefined;
  try {
    const url = new URL(key);
    url.pathname = url.pathname.replace(/-\d{1,5}x\d{1,5}(?=\.[a-z0-9]{2,5}$)/i, "");
    return url.toString();
  } catch {
    return key.replace(/-\d{1,5}x\d{1,5}(?=\.[a-z0-9]{2,5}(?:[?#]|$))/i, "");
  }
}

function sameImageAsset(left: string | undefined, right: string | undefined): boolean {
  const leftKey = imageAssetKey(left);
  const rightKey = imageAssetKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

/**
 * Captures page-specific *semantic* formula carriers before any visual MathJax
 * copies or generic attribute stripping are considered. The selector is not
 * tied to a hostname: Zhihu is simply the current common producer of this
 * accessible `data-tex` contract, and syndicated content can carry it too.
 */
function preserveSemanticFormulaCarriers($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  const carriers = root.find(".ztext-math[data-tex], [data-reader-tex], [data-tex][data-eeimg]").toArray()
    .sort((left: any, right: any) => nodeDepth(left) - nodeDepth(right));
  for (const node of carriers) {
    if (!isNodeWithinRoot(root, node)) continue;
    const element = $(node);
    if (isLiteralMathContext(element)) continue;
    const tex = String(element.attr("data-tex") || element.attr("data-reader-tex") || "").trim();
    if (!tex) continue;
    const displayMode = element.hasClass("ztext-math-block")
      || element.is("[data-display='true']")
      // Zhihu serialises some display equations without its block class and
      // leaves a final line break as its only display marker.
      || /\\\\\s*$/.test(tex);
    const normalised = displayMode ? tex.replace(/\\\\\s*$/, "").trim() : tex;
    if (!normalised) {
      element.remove();
      continue;
    }
    element.replaceWith(formulas.add(normalised, displayMode, "semantic"));
  }
}

function isLiteralMathContext(element: any): boolean {
  return element.is("code, pre") || element.parents("code, pre").length > 0;
}

/**
 * MathJax 2 stores TeX in script elements, which normally belong to the noise
 * list. Convert only explicitly-declared math scripts before the generic
 * sanitizer removes executable markup.
 */
function preserveMathScripts($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  root.find("script").each((_index: number, node: any) => {
    const script = $(node);
    if (!isMathScript(script)) return;
    const type = (script.attr("type") || "").toLowerCase();
    // Cheerio treats a script body as raw HTML, so `.text()` can be empty.
    const tex = (script.html() || script.text()).trim();
    if (!tex) {
      script.remove();
      return;
    }
    // MathJax's visual placeholder would otherwise survive as duplicate text.
    const previous = script.prev();
    if (previous.hasClass("MathJax_Preview")) previous.remove();
    // Keep a short-lived marker around an author-provided source script. A
    // browser-rendered MathJax frame often follows it as a sibling; that
    // frame is only a visual copy, and must not become a second reader
    // formula. The marker is collapsed back to plain placeholder text after
    // rendered MathJax has been reconciled below, so it never reaches the
    // renderer or user-visible HTML.
    const token = formulas.add(tex, type.includes("mode=display"), "mathjax-script");
    const index = formulas.records.length - 1;
    script.replaceWith(`<span data-reader-math-source="${index}">${token}</span>`);
  });
}

/**
 * A Scientific Spaces page may have already run MathJax before its HTML is
 * fetched. Prefer the original TeX embedded in MathJax 2/3's annotation or
 * data attributes; this avoids both the preview/rendered duplicate and losing
 * formulas when the original script was removed by the site.
 */
function preserveRenderedMathJax($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  root.find(".MathJax_Preview").remove();
  const rendered = root.find("mjx-container, .MathJax, [id^='MathJax-']").toArray()
    // Work from the outer frame inward. A MathJax 2/3 wrapper often contains
    // several elements which all match this selector. Processing a child
    // first used to create a second token, then leave that token behind when
    // its outer frame was reconciled. The outer wrapper can discover a
    // descendant annotation/script itself, so it is the only node we need.
    .sort((left: any, right: any) => nodeDepth(left) - nodeDepth(right));
  for (const node of rendered) {
    const element = $(node);
    // Cheerio keeps a detached frame's descendant linked to that detached
    // parent after the frame is replaced. `parent().length` alone therefore
    // lets an already-consumed nested MathJax node append a ghost formula,
    // which can shift later equation numbers and macro scope. Only process
    // nodes still reachable from this reader root.
    if (!isNodeWithinRoot(root, node)) continue;
    const tex = mathJaxSource(element);
    if (tex) {
      const displayMode = isRenderedMathDisplay(element);
      const authored = adjacentAuthoredMath($, element, formulas);
      if (authored && sameMathSource(authored.tex, tex)) {
        // The source script is authoritative. Keep its original position and
        // display mode, but prefer an explicit rendered block indication when
        // the source type omitted `mode=display`.
        authored.displayMode ||= displayMode;
        element.remove();
        continue;
      }
      element.replaceWith(formulas.add(tex, displayMode, "mathjax-frame"));
      continue;
    }
    // A child MathJax node may already have been replaced by its placeholder.
    // Unwrap that placeholder instead of discarding the entire formula.
    if (element.text().includes(MATH_TOKEN_PREFIX)) element.replaceWith(element.contents());
    else element.remove();
  }
  // Remove the temporary relation marker before generic sanitisation. In
  // particular, do not leave a block KaTeX result nested inside an inline
  // span, which creates browser-dependent layout/overlap behaviour.
  root.find("[data-reader-math-source]").each((_index: number, node: any) => {
    const marker = $(node);
    marker.replaceWith(marker.text());
  });
}

function nodeDepth(node: any): number {
  let depth = 0;
  for (let cursor = node?.parent; cursor; cursor = cursor.parent) depth += 1;
  return depth;
}

function isNodeWithinRoot(root: any, node: any): boolean {
  const rootNode = root.get(0);
  for (let cursor = node; cursor; cursor = cursor.parent) {
    if (cursor === rootNode) return true;
  }
  return false;
}

function mathJaxSource(element: any): string | undefined {
  // `data-mathml` is MathML, not TeX. Treating it as TeX makes the fallback
  // renderer emit a raw-source card even when the same frame has a valid TeX
  // annotation. Prefer explicit TeX fields, then the standard annotation or
  // original MathJax script. If a page retains only MathML, drop its rendered
  // shell rather than pretending it is parseable TeX.
  const direct = ["data-latex", "data-tex", "alttext"]
    .map((name) => element.attr(name))
    .find((value) => typeof value === "string" && value.trim());
  if (direct) return String(direct).trim();
  // MathJax 3 serialises its source as `<mjx-annotation>`, while MathJax 2
  // uses a standard MathML `<annotation>`. Support both explicitly: treating
  // only the latter as source silently removed every already-rendered MathJax
  // 3 equation when the static source script was unavailable.
  const annotation = element.find([
    "annotation[encoding='application/x-tex']",
    "annotation[encoding='application/x-tex; mode=display']",
    "mjx-annotation[encoding='application/x-tex']",
    "mjx-annotation[encoding='application/x-tex; mode=display']"
  ].join(", ")).first();
  const tex = annotation.text() || annotation.html() || "";
  if (tex.trim()) return tex.trim();
  const script = element.find("script[type^='math/tex']").first();
  const scriptTex = script.html() || script.text() || "";
  return scriptTex.trim() || undefined;
}

function isRenderedMathDisplay(element: any): boolean {
  return element.is("[display='true'], .MathJax_Display")
    || element.parents("[display='true'], .MathJax_Display").length > 0
    || element.find("[display='true'], .MathJax_Display").length > 0;
}

/** Finds a source-script marker immediately beside a MathJax visual frame. */
function adjacentAuthoredMath($: ReturnType<typeof load>, element: any, formulas: FormulaDocument): FormulaRecord | undefined {
  // MathJax 2 pages usually leave the source script before the rendered
  // frame, but some renderer paths emit it after the frame. Both are the same
  // authored source once their TeX agrees, so inspect immediate non-whitespace
  // siblings on either side rather than relying on one DOM ordering.
  for (const direction of ["prev", "next"] as const) {
    let sibling = element.get(0)?.[direction];
    while (sibling?.type === "text" && !String(sibling.data || "").trim()) sibling = sibling[direction];
    if (sibling?.type !== "tag") continue;
    const marker = $(sibling);
    if (!marker.is("[data-reader-math-source]")) continue;
    const index = Number.parseInt(marker.attr("data-reader-math-source") || "", 10);
    if (Number.isSafeInteger(index) && index >= 0) return formulas.get(index);
  }
  return undefined;
}

/** Ignores source-format whitespace and top-level display wrappers only. */
function sameMathSource(left: string, right: string): boolean {
  return normaliseMathSourceForComparison(left) === normaliseMathSourceForComparison(right);
}

function normaliseMathSourceForComparison(value: string): string {
  let tex = value.trim();
  tex = tex.replace(/^\$\$([\s\S]*?)\$\$$/, "$1");
  tex = tex.replace(/^\\\[([\s\S]*?)\\\]$/, "$1");
  const environment = "equation\\*?|displaymath|align\\*?|gather\\*?|multline\\*?|array|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|aligned";
  const wrappedEnvironment = new RegExp(`^\\\\begin\\{(${environment})\\}([\\s\\S]*?)\\\\end\\{\\1\\}$`);
  tex = tex.replace(wrappedEnvironment, "$2");
  return tex.replace(/\s+/g, " ").trim();
}

function isMathScript(element: any): boolean {
  const tag = element.get(0)?.tagName?.toLowerCase();
  const type = (element.attr("type") || "").toLowerCase();
  return tag === "script" && (type.startsWith("math/tex") || type.startsWith("math/asciimath"));
}

/** Converts author-delimited TeX in static HTML into placeholders. */
function preserveTextMath($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  preserveMultilineTextMath($, root, formulas);
  const visit = (node: any, insideLiteral = false): void => {
    const tag = node.tagName?.toLowerCase();
    const literal = insideLiteral || tag === "code" || tag === "pre";
    for (const child of [...(node.children || [])]) {
      if (child.type === "text" && !literal) {
        const next = tokenizeMath(child.data || "", formulas);
        if (next !== child.data) child.data = next;
      } else if (child.type === "tag") {
        visit(child, literal);
      }
    }
  };
  visit(root.get(0));
}

/**
 * Some MathJax pages put display TeX in text nodes separated by <br> or inline
 * elements. A node-by-node pass cannot see the matching \begin and \end in
 * that form, so first tokenise the smallest enclosing element as one fragment.
 */
function preserveMultilineTextMath($: ReturnType<typeof load>, root: any, formulas: FormulaDocument): void {
  const environment = "(?:equation\\*?|align\\*?|gather\\*?|multline\\*?|array|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|aligned)";
  const blockStart = new RegExp(`(?:\\\\begin\\{${environment}\\}|\\$\\$|\\\\\\\[)`);
  const candidates = root.find("*").toArray().filter((node: any) => {
    const element = $(node);
    const tag = node.tagName?.toLowerCase();
    if (tag === "code" || tag === "pre" || !blockStart.test(element.html() || "")) return false;
    return !element.children().toArray().some((child: any) => blockStart.test($(child).html() || ""));
  // A display formula can sit inside several nested list/div containers. Work
  // from the deepest live container outward, then re-check the *current* DOM
  // before each pass. Otherwise an ancestor can re-tokenise a placeholder
  // produced by a descendant into a second fake equation such as
  // `[[READING_HUB_MATH_0]]`, leaving a circular placeholder leak.
  }).sort((left: any, right: any) => nodeDepth(right) - nodeDepth(left));
  for (const node of candidates) {
    if (!isNodeWithinRoot(root, node)) continue;
    const element = $(node);
    const html = element.html() || "";
    if (!blockStart.test(html)) continue;
    let tokenised = html.replace(/\$\$([\s\S]*?)\$\$/g, (_all, body) => addMath(formulas, htmlToTeXText(body), true));
    tokenised = tokenised.replace(/\\\[([\s\S]*?)\\\]/g, (_all, body) => addMath(formulas, htmlToTeXText(body), true));
    tokenised = tokenised.replace(new RegExp(`\\\\begin\\{(${environment})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`, "g"), (_all, name, body) => {
      const tex = normaliseDisplayEnvironment(name, htmlToTeXText(body));
      return addMath(formulas, tex, true);
    });
    if (tokenised !== html) element.html(tokenised);
  }
}

function htmlToTeXText(value: string): string {
  const $ = load(`<div id="reader-math-fragment">${value.replace(/<br\s*\/?\s*>/gi, "\n")}</div>`);
  return $("#reader-math-fragment").text().replace(/\u00a0/g, " ");
}

function tokenizeMath(value: string, formulas: FormulaDocument): string {
  // Consume outer author delimiters first. A display formula may contain a
  // nested valid-looking environment; parsing that inner fragment first
  // produces a placeholder inside another placeholder and leaves one token
  // unrendered after the single render pass.
  let result = value.replace(/\\\[([\s\S]*?)\\\]/g, (_all, tex) => addMath(formulas, tex, true));
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_all, tex) => addMath(formulas, tex, true));
  result = result.replace(/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g, (_all, environment, body) => {
    const tex = normaliseDisplayEnvironment(environment, body);
    return addMath(formulas, tex, true);
  });
  result = result.replace(/\\\(([^]*?)\\\)/g, (_all, tex) => addMath(formulas, tex, false));
  return tokenizeInlineDollarMath(result, formulas);
}

function normaliseDisplayEnvironment(environment: string, body: string): string {
  const content = body.trim();
  if (environment.startsWith("align") || environment.startsWith("gather") || environment.startsWith("multline")) {
    return `\\begin{aligned}${content}\\end{aligned}`;
  }
  return content;
}

function tokenizeInlineDollarMath(value: string, formulas: FormulaDocument): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const match = inlineDollarMathAt(value, index);
    if (!match) {
      output += value[index];
      index += 1;
      continue;
    }
    output += addMath(formulas, match.tex, false);
    index = match.end;
  }
  return output;
}

function addMath(formulas: FormulaDocument, tex: string, displayMode: boolean): string {
  return formulas.add(tex, displayMode, "text");
}

type EquationMetadata = { tag?: string; label?: string };
type EquationIndex = { labels: Map<string, string>; byToken: Map<string, EquationMetadata> };

function renderMath(
  html: string,
  formulas: FormulaDocument,
  scientificMath: ScientificMathRenderer | undefined,
  globalMathDeclarations: string
): SanitizedContent {
  const prepared = formulas.records.map((record) => {
    // MathJax's package loader directives are not mathematical content. The
    // local SVG renderer loads its supported extensions explicitly, while
    // KaTeX needs the directive removed before its safe path runs.
    const declaration = extractMacroDeclarations(record.tex.replace(/\\require\{(?:cancel)\}/g, ""));
    return { record: { ...record, tex: declaration.tex }, macros: declaration.macros };
  });
  const equations = collectEquationMetadata(prepared.map((item) => item.record));
  const globalMacros = new Map<string, string>([
    ...extractMacroDeclarations(globalMathDeclarations).macros,
    ...extractMathJaxConfigMacros(globalMathDeclarations)
  ]);
  const macros = collectMathMacros([globalMacros, ...prepared.map((item) => item.macros)]);
  let rendered = 0;
  let fallback = 0;
  let result = html;

  for (const item of prepared) {
    const metadata = equations.byToken.get(item.record.token);
    // KaTeX emits self-contained HTML for common TeX, including complex
    // Scientific Spaces equations. SVG MathJax remains a safe secondary path
    // for source-specific TeX that KaTeX cannot parse; it never runs page JS.
    const katexHtml = tryRenderTeX(item.record, equations.labels, metadata, macros);
    const mathJaxHtml = katexHtml === undefined && scientificMath?.isReady()
      ? tryRenderScientificMath(scientificMath, item.record, equations.labels, metadata, macros)
      : undefined;
    const renderedHtml = katexHtml ?? mathJaxHtml;
    if (renderedHtml !== undefined) rendered += 1;
    else fallback += 1;
    result = result.replace(item.record.token, renderedHtml ?? renderMathFallback(item.record));
  }

  const dropped = formulas.records.filter((record) => result.includes(record.token)).length;
  return { html: result, formulaDiagnostics: formulas.diagnostics(rendered, fallback, dropped) };
}

function needsMathJaxFallback(value: SanitizedContent | ReaderArticle): boolean {
  return (value.formulaDiagnostics?.fallback ?? 0) > 0;
}

function collectEquationMetadata(records: FormulaRecord[]): EquationIndex {
  const labels = new Map<string, string>();
  const byToken = new Map<string, EquationMetadata>();
  let generated = 0;
  for (const record of records) {
    if (!record.displayMode) continue;
    const label = findTeXCommandGroup(record.tex, "label")?.content.trim();
    const explicitTag = findTeXCommandGroup(record.tex, "tag")?.content.trim();
    const tag = explicitTag || (label ? String(++generated) : undefined);
    const metadata = { label: label || undefined, tag };
    byToken.set(record.token, metadata);
    if (label && tag) labels.set(label, tag);
  }
  return { labels, byToken };
}

function tryRenderTeX(
  record: FormulaRecord,
  labels: Map<string, string>,
  metadata: EquationMetadata | undefined,
  macros: Record<string, string>
): string | undefined {
  const tex = prepareEquationTeX(record.tex, labels);
  if (!tex.trim()) return "";
  try {
    // The app owns all display layout and equation tags. Rendering the KaTeX
    // core in inline mode prevents its internal `.base/.tag` implementation
    // from becoming a second, version-sensitive layout system.
    const html = katex.renderToString(tex, {
      displayMode: false,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      macros,
      maxSize: 24,
      maxExpand: 1_000
    });
    return record.displayMode ? wrapDisplayEquation(html, metadata?.tag, "katex") : html;
  } catch {
    return undefined;
  }
}

function tryRenderScientificMath(
  scientificMath: ScientificMathRenderer | undefined,
  record: FormulaRecord,
  labels: Map<string, string>,
  metadata: EquationMetadata | undefined,
  macros: Record<string, string>
): string | undefined {
  if (!scientificMath) return undefined;
  const html = scientificMath.render(prepareEquationTeX(record.tex, labels), record.displayMode, macros);
  if (!html) return undefined;
  return record.displayMode ? wrapDisplayEquation(html, metadata?.tag, "mathjax") : html;
}

function prepareEquationTeX(tex: string, labels: Map<string, string>): string {
  const withoutMetadata = stripTeXCommandGroups(stripTeXCommandGroups(tex, "label"), "tag");
  const referencesResolved = withoutMetadata.replace(/\\(eqref|ref)\{([^}]+)\}/g, (_all, kind, reference) => {
    const label = labels.get(reference) || reference;
    return kind === "eqref" ? `(${label})` : label;
  });
  return normaliseTopLevelDisplayEnvironment(referencesResolved);
}

function normaliseTopLevelDisplayEnvironment(tex: string): string {
  const match = tex.trim().match(/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}$/);
  return match ? normaliseDisplayEnvironment(match[1], match[2]) : tex;
}

function wrapDisplayEquation(content: string, tag: string | undefined, renderer: "katex" | "mathjax"): string {
  const tagHtml = tag ? `<span class="reader-equation__tag" aria-label="公式编号">(${escapeHtml(tag)})</span>` : "";
  const rendererClass = renderer === "mathjax" ? " reader-equation--mathjax" : "";
  // The formula and its tag are stable flex siblings. For ordinary equations
  // the formula column consumes the available width and centres the math;
  // intrinsic-width equations expand the inner row, leaving the outer wrapper
  // as the sole horizontal scroll container. No renderer-internal geometry or
  // dynamically generated style values are needed.
  return `<span class="katex-display" data-reader-equation="true"><span class="reader-equation${rendererClass}"><span class="reader-equation__content">${content}</span>${tagHtml}</span></span>`;
}

function renderMathFallback(record: FormulaRecord): string {
  // A malformed equation must not break the article's entire layout.
  return `<code class="reader-math-source${record.displayMode ? " reader-math-source--block" : ""}">${escapeHtml(record.tex)}</code>`;
}

function findTeXCommandGroup(input: string, command: string): { content: string; start: number; next: number } | undefined {
  const expression = new RegExp(`\\\\${command}(?![A-Za-z])\\s*`, "g");
  let match: RegExpExecArray | null;
  while ((match = expression.exec(input))) {
    const group = readTeXGroup(input, match.index + match[0].length);
    if (group) return { content: group.content, start: match.index, next: group.next };
  }
  return undefined;
}

function stripTeXCommandGroups(input: string, command: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < input.length) {
    const found = findTeXCommandGroup(input.slice(cursor), command);
    if (!found) return output + input.slice(cursor);
    output += input.slice(cursor, cursor + found.start);
    cursor += found.next;
  }
  return output;
}

/**
 * Parses MathJax's object syntax with an inert, brace- and quote-aware
 * scanner. A regex cannot safely read `Macros: { rcos: ["\\\\mathop{…}"] }`
 * because the macro definition itself contains nested braces.
 */
function extractMathJaxConfigMacros(input: string): Map<string, string> {
  const macros = new Map<string, string>();
  const marker = /(?:Macros|macros)\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(input))) {
    const opening = input.indexOf("{", match.index);
    const object = readJavaScriptBalanced(input, opening, "{", "}");
    if (!object) continue;
    for (const [name, definition] of parseMathJaxMacroObject(object.content)) macros.set(name, definition);
    marker.lastIndex = object.next;
  }
  return macros;
}

function parseMathJaxMacroObject(input: string): Map<string, string> {
  const macros = new Map<string, string>();
  let cursor = 0;
  while (cursor < input.length) {
    cursor = skipJavaScriptSeparators(input, cursor);
    const key = readJavaScriptPropertyKey(input, cursor);
    if (!key) break;
    cursor = skipJavaScriptSeparators(input, key.next);
    if (input[cursor] !== ":") {
      cursor = key.next + 1;
      continue;
    }
    const value = readJavaScriptMacroValue(input, cursor + 1);
    if (!value) break;
    const name = key.value.replace(/^\\/, "").trim();
    if (/^[A-Za-z]+$/.test(name) && value.definition) macros.set(name, value.definition);
    cursor = value.next;
  }
  return macros;
}

function skipJavaScriptSeparators(input: string, start: number): number {
  let cursor = start;
  while (/[\s,;]/.test(input[cursor] || "")) cursor += 1;
  return cursor;
}

function readJavaScriptPropertyKey(input: string, start: number): { value: string; next: number } | undefined {
  const quote = input[start];
  if (quote === "'" || quote === '"') return readJavaScriptString(input, start);
  const match = input.slice(start).match(/^([A-Za-z][A-Za-z0-9_]*)/);
  return match ? { value: match[1], next: start + match[1].length } : undefined;
}

function readJavaScriptMacroValue(input: string, start: number): { definition?: string; next: number } | undefined {
  let cursor = skipJavaScriptSeparators(input, start);
  const quote = input[cursor];
  if (quote === "'" || quote === '"') {
    const value = readJavaScriptString(input, cursor);
    return value && { definition: value.value, next: value.next };
  }
  if (input[cursor] === "[") {
    const array = readJavaScriptBalanced(input, cursor, "[", "]");
    if (!array) return undefined;
    const first = readJavaScriptFirstString(array.content);
    return { definition: first, next: array.next };
  }
  if (input[cursor] === "{") {
    const object = readJavaScriptBalanced(input, cursor, "{", "}");
    return object && { next: object.next };
  }
  while (cursor < input.length && !/[,;}]/.test(input[cursor])) cursor += 1;
  return { next: cursor };
}

function readJavaScriptFirstString(input: string): string | undefined {
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    if (input[cursor] !== "'" && input[cursor] !== '"') continue;
    return readJavaScriptString(input, cursor)?.value;
  }
  return undefined;
}

function readJavaScriptString(input: string, start: number): { value: string; next: number } | undefined {
  const quote = input[start];
  let value = "";
  for (let cursor = start + 1; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (character === quote) return { value, next: cursor + 1 };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = input[cursor + 1];
    if (escaped === undefined) return undefined;
    cursor += 1;
    if (escaped === "n") value += "\n";
    else if (escaped === "r") value += "\r";
    else if (escaped === "t") value += "\t";
    else if (escaped === "b") value += "\b";
    else if (escaped === "f") value += "\f";
    else if (escaped === "v") value += "\v";
    else if (escaped === "0") value += "\0";
    else if (escaped === "\\") value += "\\";
    else value += `\\${escaped}`;
  }
  return undefined;
}

function readJavaScriptBalanced(input: string, start: number, opening: string, closing: string): { content: string; next: number } | undefined {
  if (input[start] !== opening) return undefined;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let cursor = start; cursor < input.length; cursor += 1) {
    const character = input[cursor];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return { content: input.slice(start + 1, cursor), next: cursor + 1 };
    }
  }
  return undefined;
}

/**
 * MathJax pages may declare aliases in one equation and use them much later in
 * the article. Keep the declarations out of the rendered TeX and pass their
 * definitions to KaTeX for every equation in the article.
 */
function extractMacroDeclarations(input: string): { tex: string; macros: Map<string, string> } {
  const macros = new Map<string, string>();
  let output = "";
  let cursor = 0;
  const declaration = /\\(newcommand\*?|renewcommand\*?|providecommand\*?|DeclareMathOperator\*?|(?:g|e|x)?def)(?![A-Za-z])\s*/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(input))) {
    output += input.slice(cursor, match.index);
    const parsed = parseMacroDeclaration(input, declaration.lastIndex, match[1]);
    if (!parsed) {
      output += match[0];
      cursor = declaration.lastIndex;
      continue;
    }
    macros.set(parsed.name, parsed.definition);
    cursor = parsed.next;
    declaration.lastIndex = cursor;
  }
  output += input.slice(cursor);
  return { tex: output, macros };
}

function collectMathMacros(groups: Map<string, string>[]): Record<string, string> {
  // Do not smuggle site-specific aliases into the reader. Every macro must be
  // declared by the page's safe TeX/MathJax metadata, then shared consistently
  // across its formula document.
  const macros = new Map<string, string>();
  for (const group of groups) {
    for (const [name, definition] of group) macros.set(name, definition);
  }
  return Object.fromEntries([...macros].map(([name, definition]) => [`\\${name}`, definition]));
}

function parseMacroDeclaration(input: string, start: number, kind: string): { name: string; definition: string; next: number } | undefined {
  let cursor = skipTeXWhitespace(input, start);
  if (kind.endsWith("def")) {
    const nameMatch = input.slice(cursor).match(/^\\([A-Za-z]+)/);
    if (!nameMatch) return undefined;
    const name = nameMatch[1];
    cursor += nameMatch[0].length;
    // KaTeX supports parameterised macros in its `macros` option, so retain
    // any #1…#9 markers before the replacement group.
    while (/\s|#[1-9]/.test(input.slice(cursor, cursor + 2))) {
      if (/\s/.test(input[cursor] || "")) cursor += 1;
      else cursor += 2;
    }
    const definition = readTeXGroup(input, cursor);
    return definition ? { name, definition: definition.content, next: definition.next } : undefined;
  }

  if (kind.startsWith("DeclareMathOperator")) {
    const nameGroup = readTeXGroup(input, cursor);
    if (!nameGroup) return undefined;
    const definitionGroup = readTeXGroup(input, skipTeXWhitespace(input, nameGroup.next));
    const name = nameGroup.content.replace(/^\\/, "").trim();
    if (!definitionGroup || !/^[A-Za-z]+$/.test(name)) return undefined;
    return { name, definition: `\\operatorname{${definitionGroup.content}}`, next: definitionGroup.next };
  }

  const nameGroup = readTeXGroup(input, cursor);
  if (!nameGroup) return undefined;
  cursor = skipTeXWhitespace(input, nameGroup.next);
  // \newcommand may include a parameter count and a default argument.
  // KaTeX can apply #1…#9 replacements, so retain the body and discard only
  // these declaration wrappers.
  let optional: { content: string; next: number } | undefined;
  while ((optional = readTeXOptionalGroup(input, cursor))) cursor = skipTeXWhitespace(input, optional.next);
  const definitionGroup = readTeXGroup(input, cursor);
  const name = nameGroup.content.replace(/^\\/, "").trim();
  if (!definitionGroup || !/^[A-Za-z]+$/.test(name)) return undefined;
  return { name, definition: definitionGroup.content, next: definitionGroup.next };
}

function skipTeXWhitespace(input: string, start: number): number {
  let cursor = start;
  while (/\s/.test(input[cursor] || "")) cursor += 1;
  return cursor;
}

function readTeXOptionalGroup(input: string, start: number): { content: string; next: number } | undefined {
  if (input[start] !== "[") return undefined;
  const close = input.indexOf("]", start + 1);
  return close < 0 ? undefined : { content: input.slice(start + 1, close), next: close + 1 };
}

function readTeXGroup(input: string, start: number): { content: string; next: number } | undefined {
  if (input[start] !== "{") return undefined;
  let depth = 0;
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "{" && input[index - 1] !== "\\") depth += 1;
    if (input[index] === "}" && input[index - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) return { content: input.slice(start + 1, index), next: index + 1 };
    }
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

function imageSource(element: any, pageUrl: string): string | undefined {
  const srcsets = [
    element.attr("data-srcset"),
    element.attr("data-lazy-srcset"),
    element.attr("data-reader-picture-srcset"),
    element.attr("data-reader-noscript-srcset"),
    element.attr("srcset")
  ];
  const values = [
    element.attr("data-actualsrc"),
    element.attr("data-original"),
    element.attr("data-original-src"),
    // A srcset describes resolution variants of the same image. The reader
    // has no viewport-specific source selection to preserve, so retain its
    // largest safe candidate instead of a lazy loader's lower-resolution
    // data-src placeholder.
    ...srcsets.map(bestSrcsetUrl),
    element.attr("data-src"),
    element.attr("data-lazy-src"),
    element.attr("data-reader-noscript-src"),
    element.attr("src")
  ];
  for (const value of values) {
    const src = safeUrl(value, pageUrl);
    if (src) return src;
  }
  return undefined;
}

function bestSrcsetUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // CDN transformation paths (for example Substack's `image/fetch/$…,w_…`)
  // use commas in the URL itself. A naive `split(",")` turns such a URL into
  // a truncated image endpoint. A srcset candidate boundary is the comma
  // before the next absolute or root-relative URL, not every URL character
  // comma.
  const candidates = value.split(/,\s*(?=(?:(?:https?:)?\/\/|\/))/i).map((item) => {
    const [url, descriptor] = item.trim().split(/\s+/, 2);
    const width = Number.parseInt(descriptor || "0", 10);
    return { url, width: Number.isFinite(width) ? width : 0 };
  }).filter((item) => Boolean(item.url));
  return candidates.sort((a, b) => b.width - a.width)[0]?.url;
}

function removeAllAttributes(element: any): void {
  const attributes = element.attr() as Record<string, string> | undefined;
  for (const name of Object.keys(attributes || {})) element.removeAttr(name);
}

function safeUrl(value: string | undefined, pageUrl: string): string | undefined {
  const absolute = toAbsoluteUrl(value, pageUrl);
  if (!absolute) return undefined;
  try {
    return assertPublicUrl(absolute).toString();
  } catch {
    return undefined;
  }
}

function normalText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
