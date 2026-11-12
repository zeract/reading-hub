import {ReaderConversionUnavailableError} from "./reader-conversion-errors";
import { readerFailureDiagnostic, reportReaderDiagnostic, type ReaderDiagnostic } from "./reader-diagnostics";
import { AccessChallengeError } from "./access-challenge";
import {withArticleDocument} from "./article-document";
import { readerLanguageChoices } from "../shared/reader-languages";
import { assertAnswerNavigation } from "./zhihu-answer-identity";
import { WeightedLruCache } from "./weighted-lru-cache";
import { compactText } from "../shared/text";
import { assertPublicUrl, canonicalizeUrl, isTrustedLoopbackFeedUrl } from "../shared/url";
import type { Entry, ReaderArticle, ReaderLanguageVariant, Source } from "../shared/types";
import { discoverFeedUrls, parseFeedForReading } from "./feed";
import { abortError, awaitWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";
import { isHtmlDocumentContentType, PublicHttpClient, type PublicRequestOptions } from "./http";
import { ScientificMathRenderer } from "./mathjax-renderer";
import type { PageRenderer, RenderedPage } from "./page-renderer";
import { RenderedPageHttpError } from "./rendered-document";
import { mergeReaderLanguageVariants, sameCanonicalUrl } from "./reader-language-variants";
import { RobotsDisallowedError } from "./robots";
import { escapeHtml } from "./reader-html";
import type { ReaderConverter } from "./reader-conversion";

export class ArticleContentUnavailableError extends Error {
  constructor() {
    super("这个网页没有提供可在应用内显示的正文。你仍可使用“在浏览器打开”查看原文。");
    this.name = "ArticleContentUnavailableError";
  }
}

export interface ReaderReadOptions {
  /** Shared cancellation for foreground reads and audits. */
  signal?: AbortSignal;
  priority?: "foreground" | "background";
  legacyImport?: boolean;
  inlineLanguage?: string;
  refresh?: boolean;
  /** Optional main-process audit observer; never supplied over IPC. */
  onDiagnostic?: (diagnostic: ReaderDiagnostic) => void;
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
  private readonly declaredFeedCache = new WeightedLruCache<string, { expiresAt: number; urls: string[] }>({
    maxEntries: 128, maxWeight: 1_048_576,
    weight: (key, value) => 128 + key.length * 2 + value.urls.reduce((size, url) => size + 32 + url.length * 2, 0),
    expiresAt: value => value.expiresAt
  });
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
    private readonly scientificMath = new ScientificMathRenderer(),
    private readonly converter?: ReaderConverter
  ) {}

  async read(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle> {
    const article=await this.readAtUrl(entry, source, entry.url, options, true);
    return article.document?article:withArticleDocument(article);
  }

  restoreSavedArticle(entry: Entry, article: ReaderArticle, signal?: AbortSignal): ReaderArticle {
    return this.rememberLanguageVariants(entry.id, article, [], signal);
  }

  async readLanguageVariant(entry: Entry, source: Source | undefined, rawUrl: string, options?: ReaderReadOptions): Promise<ReaderArticle> {
    const { variant, cached } = this.assertLanguageVariant(entry.id, rawUrl, options?.inlineLanguage);
    const article=await this.readAtUrl(entry, source, variant.url, options, false, cached.variants);
    return article.document?article:withArticleDocument(article);
  }

  assertLanguageVariant(entryId: string, rawUrl: string, inlineLanguage?: string) {
    const requestedUrl = assertPublicUrl(rawUrl).toString();
    const cached = this.languageVariants.get(entryId);
    const requestedCanonicalUrl = canonicalizeUrl(requestedUrl);
    const variant = cached?.variants.find((candidate) => canonicalizeUrl(candidate.url) === requestedCanonicalUrl && candidate.inlineLanguage === inlineLanguage);
    if (!cached || !variant) {
      throw new Error("这个文章的语言版本已过期或不可用，请重新打开文章后再切换。");
    }
    return { variant, cached };
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
    throwIfAborted(options?.signal);
    if (!usesZhihuSession) {
      try {
        const response = await this.http.getText(targetUrl, undefined, readerHttpOptions({ maxBytes: 8_000_000, preferHtml: true }, options?.signal));
        throwIfAborted(options?.signal);
        // JSON metadata and other declared document formats are not article
        // HTML, even when their text is long enough to pass extraction scoring.
        // Keep the existing isolated-browser/Feed fallback for unavailable HTML.
        if (response.contentType && !isHtmlDocumentContentType(response.contentType)) {
          reportReaderDiagnostic(options?.onDiagnostic, { stage: "static", reason: "unsupported_content" });
          throw new ArticleContentUnavailableError();
        }
        assertAnswerNavigation(targetUrl, response.url);
        staticArticle = await awaitWithAbort(this.extractWithMathFallback(response.text, response.url, entry, options), options?.signal);
        throwIfAborted(options?.signal);
        if (!staticArticle) reportReaderDiagnostic(options?.onDiagnostic, { stage: "static", reason: "no_content" });
        if (staticArticle && staticArticle.textLength >= 220) return this.rememberLanguageVariants(entry.id, staticArticle.article, knownLanguageVariants, options?.signal);
      } catch (error) {
        if (options?.signal?.aborted) throw abortError(options.signal);
        if (!(error instanceof ArticleContentUnavailableError)) reportReaderDiagnostic(options?.onDiagnostic, readerFailureDiagnostic("static", error));
        if(error instanceof ReaderConversionUnavailableError)throw error;
        // robots.txt must remain a hard boundary. A feed can nevertheless
        // already contain an explicitly supplied summary, which is local
        // subscription data rather than an extraction of the blocked page.
        // This makes RSSHub/X items readable without trying to fetch X again.
        if (error instanceof RobotsDisallowedError || error instanceof AccessChallengeError) {
          if (!allowFeedFallback) throw error;
          const feedBody = await this.tryFeedBody(entry, source, options);
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
      reportReaderDiagnostic(options?.onDiagnostic, readerFailureDiagnostic("render", error));
      // Keep a usable static article when Chromium rendering is unavailable.
    }
    throwIfAborted(options?.signal);
    if (renderedPage) assertAnswerNavigation(targetUrl, renderedPage.url);
    const renderedArticle = renderedPage?.html ? await awaitWithAbort(this.extractWithMathFallback(renderedPage.html, renderedPage.url, entry, options), options?.signal) : undefined;
    throwIfAborted(options?.signal);
    if (renderedPage && !renderedArticle) reportReaderDiagnostic(options?.onDiagnostic, { stage: "render", reason: "no_content" });
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
    // original page; ArticleLibrary owns any subsequent durable save.
    if (!allowFeedFallback) {
      if (failure) throw failure;
      throw new ArticleContentUnavailableError();
    }
    const sourceSummary = createSourceSummaryArticle(entry, source, failure);
    if (sourceSummary) return this.rememberLanguageVariants(entry.id, sourceSummary, knownLanguageVariants, options?.signal);
    const feedBody = await this.tryFeedBody(entry, source, options);
    if (feedBody) return this.rememberLanguageVariants(entry.id, feedBody, knownLanguageVariants, options?.signal);
    const feedSummary = createFeedSummaryArticle(entry, source);
    if (feedSummary) return this.rememberLanguageVariants(entry.id, feedSummary, knownLanguageVariants, options?.signal);
    if (failure) throw failure;
    throw new ArticleContentUnavailableError();
  }

  private async tryFeedBody(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle | undefined> {
    try {
      return await awaitWithAbort(this.readTransientFeedBody(entry, source, options), options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw abortError(options.signal);
      reportReaderDiagnostic(options?.onDiagnostic, readerFailureDiagnostic("feed", error));
      return undefined;
    }
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
   * blocked item. ArticleLibrary persists the resulting sanitized document,
   * never the untrusted feedContentHtml.
   */
  private async readTransientFeedBody(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle | undefined> {
    throwIfAborted(options?.signal);
    if (!source || !["rss", "generic"].includes(source.kind)) return undefined;
    const request = withRequestTimeout(options?.signal, 20_000, "订阅正文读取超时，请稍后重试。");
    try {
      const urls = await awaitWithAbort(this.declaredFeeds(source, request.signal), request.signal);
      let summary: ReaderArticle | undefined;
      for (const url of urls) {
        try {
          const article = await awaitWithAbort(this.readFeedEntry(entry, source, url, { ...options, signal: request.signal }), request.signal);
          if (article && article.contentMode !== "feed_summary") return article;
          summary ??= article;
        } catch (error) {
          throwIfAborted(request.signal);
          if (source.kind === "rss") throw error;
          reportReaderDiagnostic(options?.onDiagnostic, readerFailureDiagnostic("feed", error));
        }
      }
      return summary;
    } finally { request.dispose(); }
  }

  /** Only declared URLs: a site's root may publish the Feed omitted by its
   * article index. This does not change subscription scope or the sync rule. */
  private async declaredFeeds(source: Source, signal: AbortSignal): Promise<string[]> {
    if (source.kind === "rss") return [source.url];
    if (source.extractionRule?.feedUrl) return [assertPublicUrl(source.extractionRule.feedUrl).toString()];
    const sourceUrl = assertPublicUrl(source.url).toString();
    const cached = this.declaredFeedCache.get(sourceUrl);
    if (cached) return cached.urls;
    for (const pageUrl of new Set([sourceUrl, new URL("/", sourceUrl).toString()])) {
      try {
        const page = await this.http.getText(pageUrl, undefined, { signal, preferHtml: true });
        throwIfAborted(signal);
        const urls = discoverFeedUrls(page.text, page.url);
        if (!urls.length) continue;
        this.declaredFeedCache.set(sourceUrl, { urls, expiresAt: Date.now() + LANGUAGE_VARIANT_CACHE_TTL_MS });
        return urls;
      } catch (error) {
        throwIfAborted(signal);
        // This optional public page may itself be inaccessible. Never render
        // it or infer Feed endpoints from a domain/platform URL pattern.
      }
    }
    return [];
  }

  private async readFeedEntry(entry: Entry, source: Source, feedUrl: string, options: ReaderReadOptions): Promise<ReaderArticle | undefined> {
    const allowTrustedLoopbackFeed = source.kind === "rss" && source.config?.allowTrustedLoopbackFeed === true && isTrustedLoopbackFeedUrl(feedUrl);
    const response = await this.http.getText(
      feedUrl,
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
    if (!item?.feedContentHtml) {
      reportReaderDiagnostic(options?.onDiagnostic, { stage: "feed", reason: item ? "feed_body_missing" : "feed_entry_missing" });
      return item ? createSummaryArticle(entry, item.summary, "feed_summary") : undefined;
    }

    return this.readFeedBody(entry, item.feedContentHtml, response.url, options);
  }

  /** Shared import for sync-time bodies and read-time Feed fallback. */
  async readFeedBody(entry: Entry, html: string, baseUrl: string, options?: ReaderReadOptions): Promise<ReaderArticle | undefined> {
    throwIfAborted(options?.signal);
    const result = await this.convert({kind:"feed",html,url:baseUrl,entry,legacyImport:options?.legacyImport},options);
    if(!result)reportReaderDiagnostic(options?.onDiagnostic,{stage:"feed",reason:"no_content"});
    return result?.article;
  }

  private extractWithMathFallback(html:string,pageUrl:string,entry:Entry,options?:ReaderReadOptions):Promise<ExtractedArticle|undefined> {
    return this.convert({kind:"page",html,url:pageUrl,entry,inlineLanguage:options?.inlineLanguage,legacyImport:options?.legacyImport},options);
  }
  private convert(input:import("./reader-conversion").ReaderConversionRequest,options?:ReaderReadOptions) {
    return this.converter ? this.converter.convert(input,options) : import("./reader-conversion").then(({convertReaderContent})=>convertReaderContent(input,this.scientificMath,options?.signal));
  }
  async close():Promise<void>{await this.converter?.close();}

}

function readerHttpOptions(base: Omit<PublicRequestOptions, "signal"> | undefined, signal?: AbortSignal): PublicRequestOptions | undefined {
  return signal ? { ...base, signal } : base;
}

/**
 * Keeps a useful in-app reading path for feeds whose links point to a page
 * that forbids automated article retrieval. This intentionally only renders
 * the normalised, bounded summary already saved for an RSS subscription;
 * it never reaches back to the blocked origin or treats the summary as a full
 * article.
 */
function createFeedSummaryArticle(entry: Entry, source?: Source): ReaderArticle | undefined {
  const rawSummary = entry.summary;
  if (source?.kind !== "rss" || !rawSummary) return undefined;
  return createSummaryArticle(entry, rawSummary, "feed_summary");
}

/**
 * Zhihu's authorisation session may successfully collect a Follow card yet be
 * denied access to the linked answer document.  A 403 is an access boundary:
 * do not retry around it or inspect the error page.  The card's pre-existing
 * summary is still safe local metadata, so it can be shown as an explicitly
 * limited fallback without making another network request.
 */
function createSourceSummaryArticle(entry: Entry, source: Source | undefined, failure: unknown): ReaderArticle | undefined {
  if (source?.kind !== "zhihu_follow" || !(failure instanceof RenderedPageHttpError) || failure.status !== 403) return undefined;
  return createSummaryArticle(entry, entry.summary, "source_summary");
}

function createSummaryArticle(entry: Entry, rawSummary: string | undefined, contentMode: "feed_summary" | "source_summary"): ReaderArticle | undefined {
  if (!rawSummary) return undefined;
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
    contentMode,
    contentHtml: `<p>${escapeHtml(summary)}</p>`
  };
}

/**
 * Builds the source-independent portion of a reader article exactly once.
 * The sync test helper and production async MathJax path both start from this
 * inert prepared document, so they cannot diverge in root selection, noise
 * removal, metadata, or image handling.
 */
