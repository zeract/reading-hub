import { readerLanguageChoices } from "../shared/reader-languages";
import { assertAnswerNavigation } from "./zhihu-answer-identity";
import { load } from "cheerio";
import { WeightedLruCache } from "./weighted-lru-cache";
import { compactText } from "../shared/text";
import { assertPublicUrl, canonicalizeUrl, isTrustedLoopbackFeedUrl } from "../shared/url";
import type { Entry, ReaderArticle, ReaderLanguageVariant, Source } from "../shared/types";
import { parseFeedForReading } from "./feed";
import { abortError, awaitWithAbort, throwIfAborted } from "./cancellation";
import { isHtmlDocumentContentType, PublicHttpClient, type PublicRequestOptions } from "./http";
import { ScientificMathRenderer } from "./mathjax-renderer";
import type { PageRenderer, RenderedPage } from "./page-renderer";
import { RenderedPageHttpError } from "./rendered-document";
import { mergeReaderLanguageVariants, sameCanonicalUrl } from "./reader-language-variants";
import { RobotsDisallowedError } from "./robots";
import { publicDocumentUrl as safeUrl } from "./html-document-url";
import { resolveReaderProfile, prepareSanitizedContent, renderPreparedContentAsync, needsMathJaxFallback,
  selectReaderCover, effectiveReaderProfile, prepareReaderExtraction, renderPreparedReaderArticleAsync, normalText, escapeHtml } from "./reader-extraction";
export { extractReaderArticle, extractReaderArticleAsync } from "./reader-extraction";

export class ArticleContentUnavailableError extends Error {
  constructor() {
    super("这个网页没有提供可在应用内显示的正文。你仍可使用“在浏览器打开”查看原文。");
    this.name = "ArticleContentUnavailableError";
  }
}

export interface ReaderReadOptions {
  /** Shared cancellation for foreground reads and audits. */
  signal?: AbortSignal;
  inlineLanguage?: string;
}

type RenderWithSession = (url: string, options?: ReaderReadOptions) => Promise<RenderedPage>;
type ExtractedArticle = { article: ReaderArticle; textLength: number };
type LanguageVariantCache = {
  expiresAt: number;
  variants: ReaderLanguageVariant[];
};

const LANGUAGE_VARIANT_CACHE_TTL_MS = 15 * 60_000;
const MAX_LANGUAGE_VARIANT_CACHES = 240;

export class ArticleReader {
  /**
   * The renderer never gets authority to fetch an arbitrary URL.  It can only
   * switch to a publisher-declared language variant that this short-lived,
   * metadata-only cache remembers after the current article was read.
   */
  private readonly languageVariants = new WeightedLruCache<string, LanguageVariantCache>({
    maxEntries: MAX_LANGUAGE_VARIANT_CACHES,
    // Preserve the existing metadata-record budget; article HTML is never cached.
    maxWeight: MAX_LANGUAGE_VARIANT_CACHES,
    weight: () => 1,
    expiresAt: (item) => item.expiresAt
  });

  constructor(
    private readonly http: PublicHttpClient,
    private readonly renderer: PageRenderer,
    private readonly renderWithZhihuSession?: RenderWithSession,
    private readonly scientificMath = new ScientificMathRenderer()
  ) {}

  async read(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle> {
    return this.readAtUrl(entry, source, entry.url, options, true);
  }

  async readLanguageVariant(entry: Entry, source: Source | undefined, rawUrl: string, options?: ReaderReadOptions): Promise<ReaderArticle> {
    const requestedUrl = assertPublicUrl(rawUrl).toString();
    const cached = this.languageVariants.get(entry.id);
    const requestedCanonicalUrl = canonicalizeUrl(requestedUrl);
    const variant = cached?.variants.find((candidate) => canonicalizeUrl(candidate.url) === requestedCanonicalUrl && candidate.inlineLanguage === options?.inlineLanguage);
    if (!cached || !variant) {
      throw new Error("这个文章的语言版本已过期或不可用，请重新打开文章后再切换。");
    }
    return this.readAtUrl(entry, source, variant.url, options, false, cached.variants);
  }

  private async readAtUrl(
    entry: Entry,
    source: Source | undefined,
    targetUrl: string,
    options: ReaderReadOptions | undefined,
    allowFeedFallback: boolean,
    knownLanguageVariants: ReaderLanguageVariant[] = []
  ): Promise<ReaderArticle> {
    throwIfAborted(options?.signal);
    let staticArticle: ExtractedArticle | undefined;
    let staticFailure: unknown;
    const usesZhihuSession = source?.kind === "zhihu_follow" && Boolean(this.renderWithZhihuSession);
    if (resolveReaderProfile(targetUrl) === "scientific") await awaitWithAbort(this.scientificMath.ready().catch(() => undefined), options?.signal);
    throwIfAborted(options?.signal);
    if (!usesZhihuSession) {
      try {
        const response = await this.http.getText(targetUrl, undefined, readerHttpOptions({ maxBytes: 8_000_000, preferHtml: true }, options?.signal));
        throwIfAborted(options?.signal);
        // JSON metadata and other declared document formats are not article
        // HTML, even when their text is long enough to pass extraction scoring.
        // Keep the existing isolated-browser/Feed fallback for unavailable HTML.
        if (response.contentType && !isHtmlDocumentContentType(response.contentType)) throw new ArticleContentUnavailableError();
        assertAnswerNavigation(targetUrl, response.url);
        staticArticle = await awaitWithAbort(this.extractWithMathFallback(response.text, response.url, entry, options?.inlineLanguage), options?.signal);
        throwIfAborted(options?.signal);
        if (staticArticle && staticArticle.textLength >= 220) return this.rememberLanguageVariants(entry.id, staticArticle.article, knownLanguageVariants, options?.signal);
      } catch (error) {
        if (options?.signal?.aborted) throw abortError(options.signal);
        // robots.txt must remain a hard boundary. A feed can nevertheless
        // already contain an explicitly supplied summary, which is local
        // subscription data rather than an extraction of the blocked page.
        // This makes RSSHub/X items readable without trying to fetch X again.
        if (error instanceof RobotsDisallowedError) {
          if (!allowFeedFallback) throw error;
          const feedBody = await awaitWithAbort(this.readTransientFeedBody(entry, source, options), options?.signal).catch(() => {
            if (options?.signal?.aborted) throw abortError(options.signal);
            return undefined;
          });
          if (feedBody) return this.rememberLanguageVariants(entry.id, feedBody, knownLanguageVariants, options?.signal);
          const feedSummary = createFeedSummaryArticle(entry, source);
          if (feedSummary) return this.rememberLanguageVariants(entry.id, feedSummary, knownLanguageVariants, options?.signal);
          throw error;
        }
        staticFailure = error;
      }
    }

    let renderedPage: RenderedPage | undefined;
    let renderedFailure: unknown;
    try {
      renderedPage = usesZhihuSession && this.renderWithZhihuSession
        ? await this.renderWithZhihuSession(targetUrl, options)
        : await this.renderer.render(targetUrl, options);
    } catch (error) {
      if (options?.signal?.aborted) throw abortError(options.signal);
      renderedFailure = error;
      // Keep a usable static article when Chromium rendering is unavailable.
    }
    throwIfAborted(options?.signal);
    if (renderedPage) assertAnswerNavigation(targetUrl, renderedPage.url);
    const renderedArticle = renderedPage?.html ? await awaitWithAbort(this.extractWithMathFallback(renderedPage.html, renderedPage.url, entry, options?.inlineLanguage), options?.signal) : undefined;
    throwIfAborted(options?.signal);
    if (renderedArticle && renderedArticle.textLength > (staticArticle?.textLength ?? 0)) {
      return this.rememberLanguageVariants(entry.id, renderedArticle.article, knownLanguageVariants, options?.signal);
    }
    if (staticArticle) return this.rememberLanguageVariants(entry.id, staticArticle.article, knownLanguageVariants, options?.signal);
    // An observed HTTP failure is more useful than an earlier transport error.
    // Preserve local Feed fallbacks before surfacing this fixed diagnostic.
    const failure = renderedFailure instanceof RenderedPageHttpError ? renderedFailure : staticFailure ?? renderedFailure;
    // A public original can intermittently reject a reader request (or time
    // out) even though its RSS response already supplied a body. That body is
    // part of the user's subscription, so re-fetch and sanitise it in memory
    // before surfacing an avoidable read error. This never retries a blocked
    // original page and never persists full Feed content.
    if (!allowFeedFallback) {
      if (failure) throw failure;
      throw new ArticleContentUnavailableError();
    }
    const feedBody = await awaitWithAbort(this.readTransientFeedBody(entry, source, options), options?.signal).catch(() => {
      if (options?.signal?.aborted) throw abortError(options.signal);
      return undefined;
    });
    if (feedBody) return this.rememberLanguageVariants(entry.id, feedBody, knownLanguageVariants, options?.signal);
    const feedSummary = createFeedSummaryArticle(entry, source);
    if (feedSummary) return this.rememberLanguageVariants(entry.id, feedSummary, knownLanguageVariants, options?.signal);
    if (failure) throw failure;
    throw new ArticleContentUnavailableError();
  }

  private rememberLanguageVariants(entryId: string, article: ReaderArticle, knownVariants: ReaderLanguageVariant[], signal?: AbortSignal): ReaderArticle {
    throwIfAborted(signal);
    const mergedVariants = mergeReaderLanguageVariants(knownVariants.filter(item => !item.inlineLanguage || !sameCanonicalUrl(item.url, article.url)), article.languageVariants || [], article.url, article.activeLanguage);
    const variants = readerLanguageChoices(mergedVariants, article.url, article.activeLanguage);
    const activeLanguage = article.activeLanguage || variants.find((variant) => sameCanonicalUrl(variant.url, article.url))?.language;
    const result = variants.length
      ? { ...article, languageVariants: variants, ...(activeLanguage ? { activeLanguage } : {}) }
      : article;
    if (variants.length > 1 || variants.some(item => !sameCanonicalUrl(item.url, article.url) || (item.inlineLanguage && item.inlineLanguage !== activeLanguage))) {
      this.languageVariants.set(entryId, { expiresAt: Date.now() + LANGUAGE_VARIANT_CACHE_TTL_MS, variants });
    } else {
      this.languageVariants.delete(entryId);
    }
    return result;
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
    const feed = await awaitWithAbort(parseFeedForReading(response.text, response.url), options?.signal);
    throwIfAborted(options?.signal);
    const item = feed.entries.find((candidate) => {
      try {
        return requestedUrls.has(canonicalizeUrl(candidate.url));
      } catch {
        return false;
      }
    });
    if (!item?.feedContentHtml) return undefined;

    const renderProfile = resolveReaderProfile(entry.url);
    const preparedContent = prepareSanitizedContent(item.feedContentHtml, response.url);
    if (preparedContent.formulaRenderPolicy === "scientific-document" && !this.scientificMath.isReady()) {
      await awaitWithAbort(this.scientificMath.ready().catch(() => undefined), options?.signal);
    }
    throwIfAborted(options?.signal);
    let sanitised = await awaitWithAbort(renderPreparedContentAsync(preparedContent, this.scientificMath, new Map()), options?.signal);
    throwIfAborted(options?.signal);
    if (needsMathJaxFallback(sanitised) && !this.scientificMath.isReady()) {
      await awaitWithAbort(this.scientificMath.ready().catch(() => undefined), options?.signal);
      throwIfAborted(options?.signal);
      if (this.scientificMath.isReady()) sanitised = await awaitWithAbort(renderPreparedContentAsync(preparedContent, this.scientificMath, new Map()), options?.signal);
    }
    throwIfAborted(options?.signal);
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
      coverImageUrl: selectReaderCover(contentHtml, coverCandidate),
      renderProfile: effectiveReaderProfile(renderProfile, sanitised.formulaRenderPolicy),
      contentMode: "feed_body",
      formulaDiagnostics: sanitised.formulaDiagnostics,
      contentHtml
    };
  }

  /**
   * The standard path uses KaTeX first and retries only an observed failed
   * expression. A document-scoped formula policy starts local MathJax before
   * rendering so macro scope, labels and multi-row environments never mix
   * renderers. Both paths reuse the same inert extraction template.
   */
  private async extractWithMathFallback(html: string, pageUrl: string, entry: Entry, inlineLanguage?: string): Promise<ExtractedArticle | undefined> {
    const prepared = prepareReaderExtraction(html, pageUrl, entry, inlineLanguage);
    if (!prepared) return undefined;
    // Complex formula documents must not first be rendered one record at a
    // time with KaTeX and then selectively retried with MathJax.  Start the
    // local SVG renderer before the first render so macros, labels and display
    // layout use one atomic document policy from the outset.
    if (prepared.content.formulaRenderPolicy === "scientific-document" && !this.scientificMath.isReady()) {
      await this.scientificMath.ready().catch(() => undefined);
    }
    let extracted = await renderPreparedReaderArticleAsync(prepared, this.scientificMath);
    if (!extracted || !needsMathJaxFallback(extracted.article) || this.scientificMath.isReady()) return extracted;
    await this.scientificMath.ready().catch(() => undefined);
    if (this.scientificMath.isReady()) extracted = await renderPreparedReaderArticleAsync(prepared, this.scientificMath);
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

/**
 * Builds the source-independent portion of a reader article exactly once.
 * The sync test helper and production async MathJax path both start from this
 * inert prepared document, so they cannot diverge in root selection, noise
 * removal, metadata, or image handling.
 */
