import {FormulaDocument,chooseFormulaRenderPolicy,effectiveReaderProfile,preserveSemanticFormulaCarriers,preserveMathScripts,preserveRenderedMath,preserveTextMath,normaliseTeXCitationLinks,materializeFormulaAnchors,renderMath,renderMathAsync,isMathScript,type SanitizedContent,type PreparedSanitizedContent} from "./reader-formulas";
export {effectiveReaderProfile,needsMathJaxFallback} from "./reader-formulas";
import {normalText,isNodeWithinRoot} from "./reader-html";
export {escapeHtml,normalText} from "./reader-html";
import {normalizeKeyValueGrids} from "./reader-key-values";
import { removeLeadingPagePropertyPanels } from "./reader-page-properties";
import {normalizePreformattedCode} from "./reader-code";
import {articleDocumentFromHtml} from "./article-document";
import { hydrateLazyImages, imageSource, selectReaderCover } from "./reader-media";
export { selectReaderCover } from "./reader-media";
import { mergeMathMacros, extractMathJaxConfigMacros, extractMacroDeclarations, type MathMacroScope } from "./reader-math-macros";
import { readerLanguageChoices } from "../shared/reader-languages";
import { normalizeReaderLayout } from "./reader-layout";
import { selectInlineLanguages } from "./reader-inline-languages";
import {
  hasZhihuAnnotationMarker,
  isZhihuDiscussionItem,
  selectZhihuAnswer,
  ZHIHU_AUTHORED_PROSE_SELECTOR
} from "./zhihu-answer-identity";
import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { JSDOM, VirtualConsole } from "jsdom";
import { compactText, parsePublishedAt } from "../shared/text";
import type { Entry, ReaderArticle, ReaderLanguageVariant, ReaderRenderProfile } from "../shared/types";
import { extractPagePublishedAt } from "./extractor";
import { ScientificMathRenderer } from "./mathjax-renderer";
import { discoverReaderLanguageVariants, sameCanonicalUrl } from "./reader-language-variants";
import { htmlDocumentBaseUrl, publicDocumentUrl as safeUrl } from "./html-document-url";
type ExtractedArticle = { article: ReaderArticle; textLength: number };

const CONTENT_SELECTORS = [
  { selector: "article", priority: 7 },
  { selector: "[itemprop='articleBody']", priority: 6 },
  // A named body container is more specific than a bare `<article>`. Modern
  // sites commonly place small related/recommended cards in nested article
  // elements, so letting the bare tag win can select a card that later gets
  // removed as chrome and leave the reader empty.
  { selector: ".article-content, .article-body, .entry-content, .post-content, .post-body", priority: 9 },
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
  { selector: ZHIHU_AUTHORED_PROSE_SELECTOR, priority: 12 },
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

// Hugging Face places the article heading, byline, vote controls and author
// cards inside `.blog-content`, ahead of a final div containing the authored
// Markdown. The generic named-body selector is therefore still too wide.
const HUGGING_FACE_CONTENT_SELECTORS = [
  { selector: ".blog-content > div:last-child", priority: 11 },
  { selector: ".blog-content", priority: 9 },
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
// by the generic lower-case class selector below. Keep true discussion
// *containers* separate from their inline controls: a Zhihu line-comment
// marker can use the same `CommentLink` namespace while still wrapping the
// author's own prose.
const COMMENT_THREAD_CONTAINER_SELECTOR = [
  "#comment", "#comments", "#comment-list", "#commentlist",
  ".comments", ".comment-list", ".commentlist", ".comment-thread", ".comments-area", ".comment-section",
  // A list/root wrapper establishes a discussion subtree. `CommentContent`
  // on its own does not: Zhihu can reuse it for an annotation attached to
  // authored content, so its role is determined by its ancestor rather than
  // a class-name substring.
  "[class*='CommentList']", "[class*='CommentsV2']",
  "[class$='-comments']", "[class$='_comments']", "[class*='comment-list']", "[class*='comment-thread']", "[class*='comments-area']"
].join(",");

const COMMENT_THREAD_ITEM_SELECTOR = "[class*='CommentItem']";

const COMMENT_CONTROL_SELECTOR = [
  "[class*='CommentLink']", "[class*='CommentButton']", "[class*='CommentAction']", "[class*='CommentCount']",
  // Zhihu has used both kebab-case and lower-camel-case variants while
  // experimenting with line comments. Keep these as *controls* only; the
  // authored text inside a non-label control is normalized before removal.
  "[class*='commentLink']", "[class*='commentButton']", "[class*='commentAction']", "[class*='commentCount']",
  "[class*='comment-link']", "[class*='comment-button']", "[class*='comment-action']", "[class*='comment-count']"
].join(",");

// Do not use a broad `[class*='comment']` noise rule here. Zhihu marks an
// author's selected passage with the same class namespace it uses for its
// discussion UI. Whether a node is a comment is therefore a structural fact,
// not a class-name fact. Thread containers and standalone controls are
// removed; an annotation wrapper and all of its descendants remain prose.
const INLINE_COMMENT_CARRIER_TAGS = new Set([
  "a", "abbr", "b", "button", "cite", "code", "del", "em", "i", "ins", "kbd", "mark", "s", "small", "span", "strong", "sub", "sup", "u"
]);

// A line comment can mark more than one inline span. Zhihu has also attached
// it to a whole paragraph, quote or list item, so do not make text survival
// depend on an "inline" tag whitelist.
const ZHIHU_ANNOTATION_CARRIER_TAGS = new Set([
  ...INLINE_COMMENT_CARRIER_TAGS,
  "blockquote", "dd", "div", "dt", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "section"
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

type ContentCandidate = {
  html: string;
  quality: number;
  priority: number;
  title?: string;
  author?: string;
  publishedAt?: number;
};
type PreparedReaderArticle = {
  rawContentHtml: string;
  pageUrl: string;
  resourceBaseUrl: string;
  entry: Entry;
  title: string;
  author?: string;
  publishedAt?: number;
  coverCandidate?: string;
  renderProfile: ReaderRenderProfile;
  languageVariants: ReaderLanguageVariant[];
  activeLanguage?: string;
  globalMathMacros: MathMacroScope;
};
type PreparedReaderExtraction = {
  article: PreparedReaderArticle;
  content: PreparedSanitizedContent;
};

export function resolveReaderProfile(pageUrl: string): ReaderRenderProfile {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    return host === "kexue.fm" || host.endsWith(".kexue.fm") ? "scientific" : "standard";
  } catch {
    return "standard";
  }
}

/**
 * MathJax configuration normally lives in the page head, outside the chosen
 * article root. Read only explicit MathJax configuration scripts; scanning
 * every page script lets recommendation widgets or unrelated site chrome
 * redefine article macros. The script is parsed as inert text and never run.
 */
function collectGlobalMathMacros($: ReturnType<typeof load>): MathMacroScope {
  const macros: MathMacroScope = new Map();
  const seen = new Set<any>();
  $("head script, script[type*='mathjax-config'], script[id*='MathJax'][type*='config']").each((_index: number, node: any) => {
    if (seen.has(node)) return;
    seen.add(node);
    const script = $(node);
    const type = (script.attr("type") || "").toLowerCase();
    const text = script.html() || script.text() || "";
    const isMathJaxConfig = type.includes("mathjax-config")
      || /(?:MathJax(?:\.Hub)?\.Config\s*\(|(?:window\.)?MathJax\s*=)/.test(text);
    if (!isMathJaxConfig || !text.trim()) return;
    mergeMathMacros(macros, extractMacroDeclarations(text).macros);
    mergeMathMacros(macros, extractMathJaxConfigMacros(text));
  });
  return macros;
}

/**
 * Fetches an article only when it is opened. The resulting HTML is sanitised in
 * the main process and never persisted, so remote documents cannot run code in
 * the React renderer or become an on-disk full-text archive.
 */
function prepareReaderArticle(html: string, pageUrl: string, entry: Entry, inlineLanguage?: string): PreparedReaderArticle | undefined {
  let $ = load(html);
  normalizePreformattedCode($);
  normalizeKeyValueGrids($);
  // Reader View serialises selected nodes into a fresh fragment and can drop
  // the class/attribute evidence that distinguishes a CMS property panel from
  // prose. Remove a proven leading panel while the original document still
  // carries that evidence, then keep the same guard in the final sanitizer.
  removeLeadingPagePropertyPanels($, $("article, [itemprop='articleBody'], .article-content, .article-body, .entry-content, .post-content, .post-body, main"));
  html = $.html();
  const resourceBaseUrl = htmlDocumentBaseUrl($, pageUrl);
  const globalMathMacros = collectGlobalMathMacros($);
  const answerHtml = selectZhihuAnswer($, pageUrl);
  if (answerHtml) $ = load(answerHtml);
  const renderProfile = resolveReaderProfile(pageUrl);
  const inline = !answerHtml ? selectInlineLanguages($, pageUrl, inlineLanguage) : undefined;
  if (inlineLanguage && !inline) throw new Error("这个同页语言版本已不可用，请重新打开文章后再试。");
  const languageVariants = inline ? [...inline.variants, ...discoverReaderLanguageVariants($, pageUrl, resourceBaseUrl).filter(item => !sameCanonicalUrl(item.url, pageUrl))] : discoverReaderLanguageVariants($, pageUrl, resourceBaseUrl);
  const activeLanguage = inline?.activeLanguage || languageVariants.find((variant) => sameCanonicalUrl(variant.url, pageUrl))?.language;
  const content = inline ? { html: inline.html, title: undefined, author: undefined, publishedAt: undefined } : answerHtml ? pickVerifiedZhihuAnswerContent($, renderProfile, pageUrl)
    : chooseContentCandidate(pickContentRoot($, renderProfile, pageUrl), extractReadabilityContent(html, pageUrl), isHuggingFaceBlogUrl(pageUrl));
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

  const author = compactText(
    (answerHtml ? $(".AuthorInfo-name").first().text() : undefined) ||
    $("meta[name='author']").attr("content") ||
      $("[rel='author'], [class*='author']").first().text() ||
      content.author ||
      entry.author,
    160
  );
  const publishedAt = extractPagePublishedAt($) || content.publishedAt || entry.publishedAt;
  const coverCandidate = safeUrl(
    $("meta[property='og:image'], meta[name='twitter:image']").first().attr("content") || entry.imageUrl,
    resourceBaseUrl
  );
  return {
    rawContentHtml: selectedContent.html() || "",
    pageUrl,
    resourceBaseUrl,
    entry,
    title,
    author,
    publishedAt,
    coverCandidate,
    renderProfile,
    languageVariants,
    activeLanguage,
    globalMathMacros
  };
}

function finishReaderArticle(prepared: PreparedReaderArticle, sanitised: SanitizedContent): ExtractedArticle | undefined {
  const contentHtml = sanitised.html;
  const textLength = normalText(load(contentHtml).text()).length;
  if (!textLength) return undefined;
  const coverImageUrl = selectReaderCover(contentHtml, prepared.coverCandidate);

  return {
    article: {
      entryId: prepared.entry.id,
      // A reader language switch may intentionally open an author-declared
      // sibling page. Keep the active page URL here so both the external
      // button and the learning assistant refer to what is on screen.
      url: prepared.pageUrl,
      title: prepared.title,
      author: prepared.author,
      publishedAt: prepared.publishedAt,
      coverImageUrl,
      renderProfile: effectiveReaderProfile(prepared.renderProfile, sanitised.formulaRenderPolicy),
      formulaDiagnostics: sanitised.formulaDiagnostics,
      ...(prepared.languageVariants.length ? { languageVariants: readerLanguageChoices(prepared.languageVariants, prepared.pageUrl, prepared.activeLanguage) } : {}),
      ...(prepared.activeLanguage ? { activeLanguage: prepared.activeLanguage } : {}),
      document: articleDocumentFromHtml(contentHtml),
      contentHtml
    },
    textLength
  };
}

/**
 * Select and sanitise the remote DOM once. The resulting template contains
 * only inert reader markup plus internally generated formula anchors, which
 * makes a later MathJax retry deterministic and safe.
 */
export function prepareReaderExtraction(html: string, pageUrl: string, entry: Entry, inlineLanguage?: string): PreparedReaderExtraction | undefined {
  const article = prepareReaderArticle(html, pageUrl, entry, inlineLanguage);
  if (!article) return undefined;
  const content = prepareSanitizedContent(article.rawContentHtml, pageUrl, article.resourceBaseUrl);
  // Head-level MathJax macro configuration is inertly parsed while the full
  // page is available. Include it in the document policy after capture so a
  // generic host with real formula scope does not accidentally take the
  // independent-expression path.
  content.formulaRenderPolicy = chooseFormulaRenderPolicy(content.formulas, article.globalMathMacros.size > 0);
  return { article, content };
}

function renderPreparedReaderArticle(
  prepared: PreparedReaderExtraction,
  scientificMath?: ScientificMathRenderer
): ExtractedArticle | undefined {
  return finishReaderArticle(
    prepared.article,
    renderPreparedContent(prepared.content, scientificMath, prepared.article.globalMathMacros)
  );
}

export async function renderPreparedReaderArticleAsync(
  prepared: PreparedReaderExtraction,
  scientificMath?: ScientificMathRenderer
): Promise<ExtractedArticle | undefined> {
  if (prepared.content.formulaRenderPolicy === "scientific-document" && scientificMath && !scientificMath.isReady()) {
    await scientificMath.ready().catch(() => undefined);
  }
  return finishReaderArticle(
    prepared.article,
    await renderPreparedContentAsync(prepared.content, scientificMath, prepared.article.globalMathMacros)
  );
}

/** Exported for deterministic extraction tests; it does not perform network requests. */
export function extractReaderArticle(html: string, pageUrl: string, entry: Entry, scientificMath?: ScientificMathRenderer, inlineLanguage?: string): ExtractedArticle | undefined {
  const prepared = prepareReaderExtraction(html, pageUrl, entry, inlineLanguage);
  return prepared ? renderPreparedReaderArticle(prepared, scientificMath) : undefined;
}

/**
 * Production reader path. MathJax 4 may load a required TeX extension or
 * process a custom macro asynchronously, so user-visible extraction must use
 * its promise-based renderer instead of degrading a valid formula to raw TeX.
 */
export async function extractReaderArticleAsync(html: string, pageUrl: string, entry: Entry, scientificMath?: ScientificMathRenderer, inlineLanguage?: string): Promise<ExtractedArticle | undefined> {
  const prepared = prepareReaderExtraction(html, pageUrl, entry, inlineLanguage);
  return prepared ? renderPreparedReaderArticleAsync(prepared, scientificMath) : undefined;
}

function removeNoiseExceptMathScripts($: ReturnType<typeof load>, content: any, pageUrl: string): void {
  removeReaderNoise($, content, pageUrl, { preserveFormulaAssets: true });
}

/**
 * Remove non-article chrome after a source-specific body root has been chosen.
 *
 * Comment markup cannot be expressed as one CSS selector safely: the same
 * provider class can mean a block-level discussion record or a span around
 * authors' text that happens to have received a line comment. Classify the
 * former structurally and let the Zhihu normalizer unwrap the latter before
 * controls are removed. Every extraction stage uses this shared boundary so
 * candidate scoring and final sanitisation cannot disagree about which prose
 * belongs to the article.
 */
function removeReaderNoise(
  $: ReturnType<typeof load>,
  content: any,
  pageUrl: string,
  options: { preserveFormulaAssets?: boolean } = {}
): void {
  removeLeadingPagePropertyPanels($, content);
  normalizeReaderLayout($, content, pageUrl);
  preserveZhihuInlineAnnotations($, content, pageUrl);
  content.find(BASE_NOISE_SELECTOR).each((_index: number, node: any) => {
    const element = $(node);
    if (options.preserveFormulaAssets && (isMathScript(element) || isImageNoscript(element))) return;
    element.remove();
  });
  content.find("*").each((_index: number, node: any) => {
    if (!isNodeWithinRoot(content, node)) return;
    const element = $(node);
    if (isCommentThreadElement(element, content, pageUrl)) {
      element.remove();
      return;
    }
    // `preserveZhihuInlineAnnotations` has already removed comment classes
    // from author text and unwrapped an interactive quotation. Any remaining
    // matching node is therefore a standalone control, not body prose.
    if (element.is(COMMENT_CONTROL_SELECTOR)) element.remove();
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
  content.find("h1,h2,h3,h4,h5,h6").find("a.headerlink,a[href^='#']").each((_index: number, node: any) => {
    const anchor = $(node);
    const text = normalText(anchor.text());
    if (!text || /^[#¶§🔗]+$/u.test(text)) anchor.remove();
    else anchor.replaceWith(anchor.contents());
  });
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

type ContentRootOptions = {
  selectors?: ReadonlyArray<{ selector: string; priority: number }>;
  minimumTextLength?: number;
  fallbackToBody?: boolean;
};

/**
 * A selected Zhihu answer already has an exact answer-ID proof. Its authored
 * prose can therefore be a legitimate short answer, unlike a generic page's
 * navigation card. Keep this explicit context local to the answer path so
 * the 40-character generic anti-noise threshold remains unchanged elsewhere.
 */
function pickVerifiedZhihuAnswerContent($: ReturnType<typeof load>, profile: ReaderRenderProfile, pageUrl: string): ContentCandidate | undefined {
  // Candidate scoring normally clones each possible root. A comment's
  // CommentList/CommentItem ancestry would then be outside that clone and
  // unavailable to the structural discussion classifier. Clean the already
  // identity-proven answer tree first so scoring sees the same provenance as
  // final sanitisation and cannot let a long discussion reply outrank a short
  // authored answer.
  const scoped = load($.html());
  removeReaderNoise(scoped, scoped("body"), pageUrl, { preserveFormulaAssets: true });
  return pickContentRoot(scoped, profile, pageUrl, {
    selectors: [{ selector: ZHIHU_AUTHORED_PROSE_SELECTOR, priority: 12 }],
    minimumTextLength: 1,
    fallbackToBody: false
  });
}

function pickContentRoot($: ReturnType<typeof load>, profile: ReaderRenderProfile, pageUrl: string, options: ContentRootOptions = {}): ContentCandidate | undefined {
  const prefersZhihuRichContent = isZhihuContentUrl(pageUrl);
  const prefersHuggingFaceBlogBody = isHuggingFaceBlogUrl(pageUrl);
  const candidates = new Map<any, number>();
  const selectors = options.selectors ?? (profile === "scientific"
    ? SCIENTIFIC_CONTENT_SELECTORS
    : prefersZhihuRichContent
      ? ZHIHU_CONTENT_SELECTORS
      : prefersHuggingFaceBlogBody
        ? HUGGING_FACE_CONTENT_SELECTORS
        : CONTENT_SELECTORS);
  for (const { selector, priority } of selectors) {
    $(selector).each((_index, node) => {
      candidates.set(node, Math.max(candidates.get(node) || 0, priority));
    });
  }
  if (!candidates.size && options.fallbackToBody !== false) candidates.set($("body").get(0), -1);

  let best: { html: string; score: number; priority: number } | undefined;
  for (const [node, priority] of candidates) {
    if (!node) continue;
    // Candidate discovery sees every `<article>`, including the small cards
    // used by related/recommended grids. Do not let a known non-body subtree
    // enter the competition simply because its tag happens to be semantic.
    // This shares the same noise policy as final sanitisation, so a candidate
    // can no longer score highly and then disappear from the reader.
    if (isReaderNoiseCandidate($, node)) continue;
    const candidate = $(node).clone();
    // Keep semantic Math source and image noscript fallbacks while scoring;
    // the final extraction will consume them. All other chrome is removed
    // here and the cleaned fragment is returned below, avoiding a second
    // clone that could reintroduce the comments used during scoring.
    removeReaderNoise($, candidate, pageUrl, { preserveFormulaAssets: true });
    const text = normalText(candidate.text());
    if (text.length < (options.minimumTextLength ?? 40)) continue;
    const paragraphCount = candidate.find("p, li, blockquote, pre").length;
    const imageCount = candidate.find("img").length;
    const linkCount = candidate.find("a[href]").length;
    const score = Math.min(text.length, 18_000) + paragraphCount * 140 + imageCount * 90 - linkCount * 18;
    // A coherent semantic article must beat a page-sized main container even
    // when the latter contains much more sidebar and comment text.
    if (!best || priority > best.priority || (priority === best.priority && score > best.score)) {
      best = { html: candidate.html() || "", score, priority };
    }
  }
  if (!best) return undefined;
  const root = load(`<article id="reader-clean-content">${best.html}</article>`)("#reader-clean-content");
  return { html: best.html, quality: readerContentQuality(root), priority: best.priority };
}

function isReaderNoiseCandidate($: ReturnType<typeof load>, node: any): boolean {
  const candidate = $(node);
  return candidate.is(BASE_NOISE_SELECTOR) || candidate.parents(BASE_NOISE_SELECTOR).length > 0;
}

function isZhihuContentUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "zhihu.com" || host.endsWith(".zhihu.com");
  } catch {
    return false;
  }
}

function isHuggingFaceBlogUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === "huggingface.co" && url.pathname.startsWith("/blog/");
  } catch {
    return false;
  }
}

function isCommentThreadElement(element: any, content?: any, pageUrl?: string): boolean {
  if (!element.is(COMMENT_THREAD_CONTAINER_SELECTOR) && !element.is(COMMENT_THREAD_ITEM_SELECTOR)) return false;
  if (element.is(COMMENT_THREAD_CONTAINER_SELECTOR)) return true;
  // A discussion item can appear inside the selected RichContent shell on
  // older page layouts. Its explicit discussion-root ancestor always wins
  // over the local annotation exception below.
  if (element.parents(COMMENT_THREAD_CONTAINER_SELECTOR).length) return true;
  // Use the same structural distinction as the hydration poll. A bare
  // `CommentItem` in an authored RichContent root can be a line-comment
  // wrapper, while an article/list or explicit comment record remains a
  // discussion item even when it happens to carry a highlight class.
  if (isZhihuContentUrl(pageUrl || "")) return isZhihuDiscussionItem(element, content);
  const tagName = element.get(0)?.tagName?.toLowerCase();
  if (!tagName || INLINE_COMMENT_CARRIER_TAGS.has(tagName)) return false;
  return true;
}

function hasZhihuAnnotationAncestor(element: any, annotationNodes?: Set<any>): boolean {
  if (!annotationNodes?.size) return false;
  for (let parent = element.parent(); parent.length; parent = parent.parent()) {
    if (annotationNodes.has(parent.get(0))) return true;
  }
  return false;
}

function hasCommentThreadAncestor(element: any, content?: any, pageUrl?: string): boolean {
  for (let parent = element.parent(); parent.length; parent = parent.parent()) {
    if (isCommentThreadElement(parent, content, pageUrl)) return true;
  }
  return false;
}

/**
 * Zhihu may wrap selected authored text in an inline marker when readers have
 * commented on that passage. The generic noise rule deliberately removes
 * comment *threads*, so normalize authored annotation wrappers before it runs.
 *
 * Normalize comment-bearing class tokens rather than the element or its
 * entire class list. This retains normal text semantics and essential
 * semantic carriers such as Zhihu's `ztext-math` / `ztext-math-block`, while
 * the sanitizer still strips all remote presentation classes later.
 * Block-level CommentList/CommentItem ancestors are deliberately left intact
 * here and removed by the structural discussion-thread classifier.
 */
function preserveZhihuInlineAnnotations($: ReturnType<typeof load>, content: any, pageUrl: string): void {
  if (!isZhihuContentUrl(pageUrl)) return;
  // This only exists during a single sanitisation pass. It is intentionally a
  // local identity set, rather than a data attribute, so a remote page cannot
  // forge the provenance of an annotation subtree.
  const annotationNodes = new Set<any>();
  const nodes = content.find("[class]").toArray();
  if (content.is("[class]")) nodes.unshift(content.get(0));
  for (const node of nodes) {
    if (!isNodeWithinRoot(content, node)) continue;
    const element = $(node);
    const tagName = element.get(0)?.tagName?.toLowerCase();
    const className = element.attr("class") || "";
    if (!tagName || !ZHIHU_ANNOTATION_CARRIER_TAGS.has(tagName)) continue;
    if (isCommentThreadElement(element, content, pageUrl)
      || hasCommentThreadAncestor(element, content, pageUrl)) continue;

    const isCommentControl = element.is(COMMENT_CONTROL_SELECTOR);
    // Do not tie authored prose to a particular Zhihu experiment class such
    // as `RichContent-commented-inline`. Any inline wrapper carrying a
    // comment/annotation marker inside the selected RichContent root can be
    // author text. Actual thread containers were excluded above, and a
    // standalone control label is filtered below.
    const carriesLineCommentMarker = hasZhihuAnnotationMarker(className) || /(?:comment|annotation)/i.test(className);
    // The selected reader root can itself be `.RichContent-inner` or
    // `.Post-RichTextContainer`; at that point its class is intentionally
    // not retained in the cloned fragment. Rely on the already-selected
    // Zhihu article root plus the explicit thread/control checks above,
    // rather than requiring a class-bearing ancestor that may no longer be
    // present after root selection.
    const inheritsLineCommentMarker = hasZhihuAnnotationAncestor(element, annotationNodes);
    if (!carriesLineCommentMarker && !inheritsLineCommentMarker) continue;

    // A labelled control remains UI even when an experiment happens to put a
    // generic annotation class on it. Buttons are handled too: a line-comment
    // experiment can make the quoted author passage clickable with a button,
    // but ordinary button controls must still disappear with the page chrome.
    const isButton = tagName === "button";
    if ((isCommentControl || isButton) && isZhihuCommentControlLabel(element)) continue;

    annotationNodes.add(node);
    if (carriesLineCommentMarker) {
      const retainedClasses = className
        .split(/\s+/)
        .filter((classToken) => classToken && !/(?:comment|annotation)/i.test(classToken));
      if (retainedClasses.length) element.attr("class", retainedClasses.join(" "));
      else element.removeAttr("class");
    }
    if (isCommentControl || isButton) element.replaceWith(element.contents());
  }
}

/**
 * Zhihu's visible comment controls are short, purpose-specific labels. This
 * is deliberately narrower than a general prose heuristic: it lets us retain
 * a `CommentLink` wrapper around an authored quotation without accidentally
 * retaining standalone “3 条评论” / “写评论” controls.
 */
function isZhihuCommentControlLabel(element: any): boolean {
  const text = normalText(element.text()).replace(/\s+/g, "");
  if (!text) return true;
  return /^(?:(?:查看(?:全部)?|展开|收起|写|添加|参与)?(?:\d[\d,.]*)?(?:条)?)?评论(?:\d[\d,.]*)?$/i.test(text)
    || /^(?:(?:view|show|hide|write|add|all)?\d*)?comments?$/i.test(text);
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

function chooseContentCandidate(semantic: ContentCandidate | undefined, readable: ContentCandidate | undefined, preferVerifiedInnerBody = false): ContentCandidate | undefined {
  if (!semantic) return readable;
  if (!readable) return semantic;
  // A verified inner body is a stronger boundary than Reader View's broader
  // text-density guess. The latter can reintroduce bylines and related cards
  // even when a source's authored-prose container was found successfully.
  if (preferVerifiedInnerBody && semantic.priority >= 11) return semantic;
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

export function prepareSanitizedContent(rawHtml: string, pageUrl: string, resourceBaseUrl = pageUrl): PreparedSanitizedContent {
  const $ = load(`<div id="reader-content">${rawHtml}</div>`);
  normalizePreformattedCode($);
  const root = $("#reader-content");
  hydrateLazyImages($, root, resourceBaseUrl);
  // Drop thread containers before their nested TeX/image markup can enter
  // the formula or media pipeline. Preserve Math source assets at this point;
  // they are consumed and removed by the following formula pass.
  removeReaderNoise($, root, pageUrl, { preserveFormulaAssets: true });
  const formulas = new FormulaDocument();
  // Semantic containers must be consumed first. In particular, Zhihu wraps
  // `data-tex` around a MathJax SVG visual copy; looking at the child frame
  // first loses the only source TeX when generic sanitisation removes data/SVG.
  preserveSemanticFormulaCarriers($, root, formulas);
  preserveMathScripts($, root, formulas);
  preserveRenderedMath($, root, formulas);
  removeReaderNoise($, root, pageUrl);
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
    if (tag === "video") {
      // Build a fresh inert media block; remote sources, autoplay, event
      // handlers and unsupported-browser fallback prose never reach the DOM.
      const candidates = [element.attr("src"), ...element.find("source").toArray().map(node => $(node).attr("src"))];
      const sources = [...new Set(candidates.map(value => safeUrl(value, resourceBaseUrl)).filter((value): value is string => Boolean(value?.startsWith("https:"))))].slice(0, 4);
      const block = $("<div>").attr("class", "reader-video");
      if (sources.length) {
        const video = $("<video>").attr("controls", "").attr("playsinline", "").attr("preload", "none").attr("data-reader-video-sources", JSON.stringify(sources));
        const label = normalText(element.attr("aria-label") || element.attr("title") || "文章视频");
        video.attr("aria-label", label.slice(0, 300));
        block.append(video, $("<button>").attr("type", "button").attr("data-reader-video-load", "true").attr("class", "action-button").text("加载视频"));
        block.append($("<span>").attr("role", "status").attr("class", "reader-video-status"));
      }
      block.append($("<a>").attr("href", pageUrl).text(sources.length ? "在原文中观看视频" : "此处包含暂不支持的视频 · 在原文中观看"));
      element.replaceWith(block);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(element.contents());
      continue;
    }
    if (tag === "img") {
      const src = imageSource(element, resourceBaseUrl);
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
      const href = safeUrl(element.attr("href"), resourceBaseUrl);
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
    if (tag === "ol") {
      const start=element.attr("start");
      removeAllAttributes(element);
      if(start && /^-?\d{1,9}$/.test(start))element.attr("start",String(Number(start)));
      continue;
    }
    removeAllAttributes(element);
  }
  preserveTextMath($, root, formulas);
  normaliseTeXCitationLinks($, root, resourceBaseUrl);
  materializeFormulaAnchors($, root, formulas);
  // Preserve only our already-sanitised template and formula IR. Retry paths
  // re-instantiate this inert DOM rather than selecting/extracting remote
  // HTML a second time, so fallback rendering cannot change content roots,
  // formula order, or macro scope between passes.
  return { html: root.html() || "", formulas, formulaRenderPolicy: chooseFormulaRenderPolicy(formulas) };
}

function instantiateSanitizedContent(prepared: PreparedSanitizedContent): { $: ReturnType<typeof load>; root: any } {
  const $ = load(`<div id="reader-content">${prepared.html}</div>`);
  return { $, root: $("#reader-content") };
}

function renderPreparedContent(
  prepared: PreparedSanitizedContent,
  scientificMath: ScientificMathRenderer | undefined,
  globalMathMacros: MathMacroScope
): SanitizedContent {
  const { $, root } = instantiateSanitizedContent(prepared);
  return renderMath($, root, prepared.formulas, scientificMath, globalMathMacros, prepared.formulaRenderPolicy);
}

export async function renderPreparedContentAsync(
  prepared: PreparedSanitizedContent,
  scientificMath: ScientificMathRenderer | undefined,
  globalMathMacros: MathMacroScope
): Promise<SanitizedContent> {
  const { $, root } = instantiateSanitizedContent(prepared);
  return renderMathAsync($, root, prepared.formulas, scientificMath, globalMathMacros, prepared.formulaRenderPolicy);
}

function removeAllAttributes(element: any): void {
  const attributes = element.attr() as Record<string, string> | undefined;
  for (const name of Object.keys(attributes || {})) element.removeAttr(name);
}
