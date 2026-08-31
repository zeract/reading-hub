import {
  isHtmlDocumentContentType,
  NetworkRequestError,
  PublicHttpClient,
  ResponseTooLargeError,
  type TextResponse
} from "./http";
import { isAmbiguousFeedContentType, isExplicitFeedContentType } from "./feed";
import type { PageRenderer } from "./page-renderer";

export interface GenericPageLoadOptions {
  cached?: Pick<TextResponse, "etag" | "lastModified">;
  /** A previously verified page needs Chromium every time it is refreshed. */
  preferRenderer?: boolean;
  signal?: AbortSignal;
}

/** A generic web page loaded from a bounded static response or isolated Chromium. */
export interface LoadedGenericPage {
  url: string;
  text: string;
  contentType: string;
  /** The static response is intentionally absent after a rendered fallback. */
  response?: TextResponse;
  fromRenderer: boolean;
}

/**
 * Source preview, visual calibration and recurring generic sync must make the
 * same choice between static HTML and isolated rendering. Keeping that policy
 * here prevents a source from previewing successfully only to fail on its
 * first scheduled refresh.
 */
export async function loadGenericPage(
  http: PublicHttpClient,
  renderer: PageRenderer | undefined,
  url: string,
  options?: GenericPageLoadOptions
): Promise<LoadedGenericPage> {
  if (options?.preferRenderer && renderer) return renderPage(renderer, url, options?.signal);
  try {
    const response = await http.getText(url, options?.cached, options?.signal ? { signal: options.signal } : undefined);
    return { url: response.url, text: response.text, contentType: response.contentType, response, fromRenderer: false };
  } catch (error) {
    if (!renderer || !shouldUseRenderedFallback(error)) throw error;
    const targetUrl = error instanceof ResponseTooLargeError ? error.url : url;
    return renderPage(renderer, targetUrl, options?.signal);
  }
}

function shouldUseRenderedFallback(error: unknown): boolean {
  // A transport failure has no reliable content type. This preserves the
  // existing public-page fallback. Verified Feed responses stay outside the
  // renderer and retain their parser-specific bounded path below.
  return error instanceof NetworkRequestError
    || (error instanceof ResponseTooLargeError && isRenderableHtmlResponse(error));
}

/**
 * Some publishers send HTML as text/plain or omit the MIME type. They are
 * still safe candidates for the same isolated, cookie-free HTML renderer.
 * A verified Feed remains in the parser path, while clearly binary documents
 * are never treated as webpages.
 */
function isRenderableHtmlResponse(error: ResponseTooLargeError): boolean {
  // A verified Feed must stay in the parser path; Chromium is not a Feed
  // parser. Other textual/XML responses can be safely retried in the same
  // isolated renderer when their MIME type was missing or misleading.
  if (error.documentKind === "feed") return false;
  if (isHtmlDocumentContentType(error.contentType)) return true;
  // Do not attempt to render arbitrary application responses (for example a
  // JavaScript bundle accidentally pasted as a source). The whitelist is
  // deliberately narrow: blank/plain/XML/JSON and syndication MIME types
  // only reach here after Feed-signature inspection, so they may safely be a
  // mislabeled public HTML page when that inspection failed.
  return isAmbiguousFeedContentType(error.contentType) || isExplicitFeedContentType(error.contentType);
}

async function renderPage(renderer: PageRenderer, url: string, signal?: AbortSignal): Promise<LoadedGenericPage> {
  const text = await renderer.render(url, signal ? { signal } : undefined);
  return { url, text, contentType: "text/html", fromRenderer: true };
}
