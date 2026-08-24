import {
  isHtmlDocumentContentType,
  NetworkRequestError,
  PublicHttpClient,
  ResponseTooLargeError,
  type TextResponse
} from "./http";
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
  // existing public-page fallback, whereas an oversized non-HTML response is
  // never handed to Chromium as if it were an article list.
  return error instanceof NetworkRequestError
    || (error instanceof ResponseTooLargeError && isHtmlDocumentContentType(error.contentType));
}

async function renderPage(renderer: PageRenderer, url: string, signal?: AbortSignal): Promise<LoadedGenericPage> {
  const text = await renderer.render(url, signal ? { signal } : undefined);
  return { url, text, contentType: "text/html", fromRenderer: true };
}
