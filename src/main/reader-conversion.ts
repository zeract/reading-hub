import { load } from "cheerio";
import type { Entry, ReaderArticle } from "../shared/types";
import { articleDocumentFromHtml, withArticleDocument } from "./article-document";
import { throwIfAborted } from "./cancellation";
import { publicDocumentUrl as safeUrl } from "./html-document-url";
import { ScientificMathRenderer } from "./mathjax-renderer";
import { effectiveReaderProfile, needsMathJaxFallback, normalText, prepareReaderExtraction, prepareSanitizedContent, renderPreparedContentAsync, renderPreparedReaderArticleAsync, resolveReaderProfile, selectReaderCover } from "./reader-extraction";
export type ExtractedArticle = {
    article: ReaderArticle;
    textLength: number;
};
export type ReaderConversionRequest = {
    kind: "page" | "feed";
    html: string;
    url: string;
    entry: Entry;
    inlineLanguage?: string;
    legacyImport?: boolean;
};
export type ReaderConversionResult = ExtractedArticle | undefined;
export interface ReaderConverter {
    convert(request: ReaderConversionRequest, options?: {
        signal?: AbortSignal;
        priority?: "foreground" | "background";
    }): Promise<ReaderConversionResult>;
    close(): Promise<void>;
}
/** The sole conversion implementation, shared by the isolated worker and deterministic fixtures. */
export async function convertReaderContent(request: ReaderConversionRequest, math: ScientificMathRenderer, signal?: AbortSignal): Promise<ReaderConversionResult> {
    throwIfAborted(signal);
    const { html, url, entry } = request;
    if (request.kind === "page") {
        const prepared = prepareReaderExtraction(html, url, entry, request.inlineLanguage);
        throwIfAborted(signal);
        if (!prepared)
            return;
        if (prepared.content.formulaRenderPolicy === "scientific-document" && !math.isReady())
            await math.ready().catch(() => undefined);
        throwIfAborted(signal);
        let result = await renderPreparedReaderArticleAsync(prepared, math, signal);
        throwIfAborted(signal);
        if (result && needsMathJaxFallback(result.article) && !math.isReady()) {
            await math.ready().catch(() => undefined);
            throwIfAborted(signal);
            if (math.isReady())
                result = await renderPreparedReaderArticleAsync(prepared, math, signal);
        }
        return result ? { ...result, article: withArticleDocument(result.article) } : undefined;
    }
    const prepared = prepareSanitizedContent(html, url);
    throwIfAborted(signal);
    if (prepared.formulaRenderPolicy === "scientific-document" && !math.isReady())
        await math.ready().catch(() => undefined);
    throwIfAborted(signal);
    let sanitized = await renderPreparedContentAsync(prepared, math, new Map(), signal);
    throwIfAborted(signal);
    if (needsMathJaxFallback(sanitized) && !math.isReady()) {
        await math.ready().catch(() => undefined);
        throwIfAborted(signal);
        if (math.isReady())
            sanitized = await renderPreparedContentAsync(prepared, math, new Map(), signal);
    }
    throwIfAborted(signal);
    const content = load(sanitized.html), textLength = normalText(content.text()).length;
    if (textLength < 24 && !content("img").length)
        return;
    const article: ReaderArticle = { entryId: entry.id, url: entry.url, title: entry.title, author: entry.author, publishedAt: entry.publishedAt,
        coverImageUrl: selectReaderCover(sanitized.html, safeUrl(entry.imageUrl, url)), renderProfile: effectiveReaderProfile(resolveReaderProfile(entry.url), sanitized.formulaRenderPolicy),
        contentMode: "feed_body", formulaDiagnostics: sanitized.formulaDiagnostics, document: articleDocumentFromHtml(sanitized.html), contentHtml: sanitized.html };
    return { article: withArticleDocument(article), textLength };
}
