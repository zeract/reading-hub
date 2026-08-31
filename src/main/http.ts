import { assertFeedSubscriptionUrl, assertPublicUrl, isTrustedLoopbackFeedUrl } from "../shared/url";
import { abortError, throwIfAborted, withRequestTimeout } from "./cancellation";
import { formatByteLimit } from "./byte-limit";
import { hasFeedSignature, isAmbiguousFeedContentType, isExplicitFeedContentType } from "./feed";
import { chromiumFetch } from "./network";
import { RobotsPolicy } from "./robots";

export interface TextResponse {
  url: string;
  status: number;
  contentType: string;
  text: string;
  etag?: string;
  lastModified?: string;
}

export interface PublicRequestOptions {
  maxBytes?: number;
  /**
   * Optional larger budget used only after a response has been verified as a
   * RSS/Atom/JSON Feed. Omit it to use the normal source-feed budget whenever
   * `maxBytes` is also omitted.
   */
  maxFeedBytes?: number;
  allowTrustedLoopbackFeed?: boolean;
  /** Optional caller-owned cancellation. Normal app requests do not use it. */
  signal?: AbortSignal;
}

/**
 * Normal source pages are deliberately kept smaller than full reader
 * documents. A source only needs enough HTML to discover a Feed or extract a
 * list of cards; the reader has its own, larger per-article budget.
 */
export const DEFAULT_SOURCE_DOCUMENT_MAX_BYTES = 3_000_000;

/**
 * Feeds can legitimately contain more historical cards than a source page.
 * This remains a bounded, streamed read; it is not a permission to load an
 * arbitrary large webpage into the main process.
 */
export const DEFAULT_FEED_DOCUMENT_MAX_BYTES = 12_000_000;

/** Enough bytes to find XML roots or a JSON Feed version without buffering a page. */
const FEED_SIGNATURE_SNIFF_BYTES = 64_000;

/** A bounded response exceeded its documented byte budget. */
export class ResponseTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly contentType: string,
    readonly url: string,
    readonly receivedBytes?: number,
    readonly documentKind: "page" | "feed" = "page"
  ) {
    super(`${documentKind === "feed" ? "Feed 响应" : "页面响应"}超过 ${formatByteLimit(maxBytes)}，已拒绝读取。`);
    this.name = "ResponseTooLargeError";
  }
}

/** A transport failure after robots policy has already allowed the request. */
export class NetworkRequestError extends Error {
  constructor(cause?: unknown) {
    super(networkFailureMessage(cause));
    this.name = "NetworkRequestError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * The failed-image fallback intentionally converts only raster images to data
 * URLs. SVG can carry active/external content, so it remains a direct browser
 * image and is never proxied until a dedicated SVG sanitiser exists.
 */
export class UnsupportedReaderImageTypeError extends Error {
  constructor(readonly contentType: string) {
    super("远程资源不是可安全由本地代理显示的图片。");
    this.name = "UnsupportedReaderImageTypeError";
  }
}

/** Only HTML can safely benefit from the isolated-browser extraction path. */
export function isHtmlDocumentContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function networkFailureMessage(cause: unknown): string {
  const details = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause || "");
  if (/ERR_(?:PROXY|TUNNEL|SOCKS)_|proxy/i.test(details)) return "无法连接到配置的代理服务器。请确认代理正在运行，或检查系统/环境代理设置后重试。";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|dns/i.test(details)) return "无法解析该站点的域名。请检查 DNS、VPN 或网络设置后重试。";
  if (/ERR_TIMED_OUT|timeout|timed out|aborted/i.test(details)) return "该站点响应超时。请稍后重试，或检查网络与代理设置。";
  return "无法连接到该站点。请检查网络或系统代理设置后重试。";
}

export class PublicHttpClient {
  constructor(private readonly robots = new RobotsPolicy()) {}

  private readonly imageCache = new Map<string, string>();

  async getText(rawUrl: string, cached?: { etag?: string; lastModified?: string }, options?: PublicRequestOptions): Promise<TextResponse> {
    const maxBytes = options?.maxBytes ?? DEFAULT_SOURCE_DOCUMENT_MAX_BYTES;
    const maxFeedBytes = normalisedFeedByteLimit(options, maxBytes);
    const localFeed = options?.allowTrustedLoopbackFeed === true && isTrustedLoopbackFeedUrl(rawUrl);
    const localFeedOrigin = localFeed ? assertFeedSubscriptionUrl(rawUrl, true).origin : undefined;
    let targetUrl = localFeed ? assertFeedSubscriptionUrl(rawUrl, true).toString() : assertPublicUrl(rawUrl).toString();
    const headers: Record<string, string> = {
      "User-Agent": "ReadingHub/0.1 (+local reader)",
      Accept: "application/atom+xml, application/rss+xml, application/feed+json, application/json, text/html;q=0.9, */*;q=0.1"
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      throwIfAborted(options?.signal);
      if (!localFeed) await this.robots.assertAllowed(targetUrl, { signal: options?.signal });
      const request = withRequestTimeout(options?.signal, 20_000, "该站点响应超时。请稍后重试，或检查网络与代理设置。");
      try {
        // Redirects are followed explicitly so every destination is checked for
        // public-address and robots policy compliance.
        let response: Response;
        try {
          response = await chromiumFetch(targetUrl, { headers, redirect: "manual", signal: request.signal });
        } catch (error) {
          if (options?.signal?.aborted) throw abortError(options.signal);
          throw new NetworkRequestError(error);
        }
        const location = response.headers.get("location");
        if (location && response.status >= 300 && response.status < 400) {
          if (redirectCount === 5) throw new Error("重定向次数过多，已停止请求。");
          const redirected = new URL(location, targetUrl);
          if (localFeed) {
            if (!isTrustedLoopbackFeedUrl(redirected.toString()) || redirected.origin !== localFeedOrigin) {
              throw new Error("本机 Feed 不能重定向到其他地址。");
            }
            targetUrl = redirected.toString();
          } else {
            targetUrl = assertPublicUrl(redirected.toString()).toString();
          }
          continue;
        }
        if (response.status === 304) {
          return { url: targetUrl, status: 304, contentType: response.headers.get("content-type") ?? "", text: "" };
        }
        if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
        const contentType = response.headers.get("content-type") ?? "";
        const declaredSize = Number(response.headers.get("content-length") ?? 0);
        const feedCandidate = isExplicitFeedContentType(contentType) || isAmbiguousFeedContentType(contentType);
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes && !feedCandidate) {
          // A declared size lets us reject before creating a body reader. Tell
          // Chromium to stop consuming the response so a preview cannot keep
          // an unnecessarily large transfer alive in the background.
          void response.body?.cancel().catch(() => undefined);
          throw new ResponseTooLargeError(maxBytes, contentType, targetUrl, declaredSize);
        }
        try {
          const text = await readTextWithinLimit(response, {
            maxBytes,
            maxFeedBytes,
            declaredSize: Number.isFinite(declaredSize) ? declaredSize : undefined
          }, contentType, targetUrl);
          return {
            url: targetUrl,
            status: response.status,
            contentType,
            text,
            etag: response.headers.get("etag") ?? undefined,
            lastModified: response.headers.get("last-modified") ?? undefined
          };
        } catch (error) {
          if (error instanceof ResponseTooLargeError) throw error;
          if (options?.signal?.aborted) throw abortError(options.signal);
          throw new NetworkRequestError(error);
        }
      } finally {
        request.dispose();
      }
    }
    throw new Error("重定向次数过多，已停止请求。");
  }

  /**
   * Retries a failed reader image in the trusted main process. The data URL is
   * held only in memory, uses the public article as its referrer, and every
   * redirect is checked against the same public-address and robots policy as
   * article requests.
   */
  async getImageDataUrl(rawUrl: string, rawReferrer: string, options?: Pick<PublicRequestOptions, "signal">): Promise<string> {
    throwIfAborted(options?.signal);
    const referrer = assertPublicUrl(rawReferrer).toString();
    let targetUrl = assertPublicUrl(rawUrl).toString();
    const cacheKey = `${referrer}\u0000${targetUrl}`;
    const cached = this.imageCache.get(cacheKey);
    if (cached) return cached;

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      throwIfAborted(options?.signal);
      await this.robots.assertAllowed(targetUrl, { signal: options?.signal });
      const request = withRequestTimeout(options?.signal, 20_000, "图片请求超时。请稍后重试，或检查网络与代理设置。");
      try {
        let response: Response;
        try {
          response = await chromiumFetch(targetUrl, {
            headers: {
              "User-Agent": "ReadingHub/0.1 (+local reader)",
              Accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/x-icon,image/vnd.microsoft.icon;q=0.9,*/*;q=0.1"
            },
            redirect: "manual",
            referrer,
            referrerPolicy: "strict-origin-when-cross-origin",
            signal: request.signal
          });
        } catch (error) {
          if (options?.signal?.aborted) throw abortError(options.signal);
          throw new NetworkRequestError(error);
        }
        const location = response.headers.get("location");
        if (location && response.status >= 300 && response.status < 400) {
          if (redirectCount === 5) throw new Error("图片重定向次数过多，已停止请求。");
          targetUrl = assertPublicUrl(new URL(location, targetUrl).toString()).toString();
          continue;
        }
        if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）`);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() || "";
        if (!/^(image\/(?:avif|gif|jpe?g|png|webp|x-icon|vnd\.microsoft\.icon))$/.test(contentType)) {
          throw new UnsupportedReaderImageTypeError(contentType);
        }
        const maxBytes = 8_000_000;
        const size = Number(response.headers.get("content-length") ?? 0);
        if (size > maxBytes) throw new Error("图片响应超过 8 MB，已跳过加载。");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) throw new Error("图片响应超过 8 MB，已跳过加载。");
        const result = `data:${contentType};base64,${bytes.toString("base64")}`;
        this.imageCache.set(cacheKey, result);
        if (this.imageCache.size > 24) this.imageCache.delete(this.imageCache.keys().next().value!);
        return result;
      } finally {
        request.dispose();
      }
    }
    throw new Error("图片重定向次数过多，已停止请求。");
  }
}

/**
 * `Response.text()` first buffers an entire body and counts UTF-16 code units,
 * neither of which implements an actual network-byte limit. Read chunks as
 * bytes instead, cancelling as soon as the caller's budget is exceeded.
 */
type TextByteLimits = {
  maxBytes: number;
  maxFeedBytes: number;
  declaredSize?: number;
};

/**
 * Reads an ordinary source page within its normal budget, while allowing a
 * larger bounded read only after a short prefix confirms RSS/Atom/JSON Feed
 * syntax. This avoids trusting a missing or misleading Content-Type header.
 */
async function readTextWithinLimit(response: Response, limits: TextByteLimits, contentType: string, url: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const prefixChunks: Uint8Array[] = [];
  let prefixBytes = 0;
  const mayBeFeed = isExplicitFeedContentType(contentType) || isAmbiguousFeedContentType(contentType);
  let isFeed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (mayBeFeed && prefixBytes < FEED_SIGNATURE_SNIFF_BYTES) {
        const remaining = FEED_SIGNATURE_SNIFF_BYTES - prefixBytes;
        const prefix = value.byteLength <= remaining ? value : value.subarray(0, remaining);
        prefixChunks.push(prefix);
        prefixBytes += prefix.byteLength;
        if (hasFeedSignature(decodeChunks(prefixChunks, prefixBytes))) isFeed = true;
      }
      receivedBytes += value.byteLength;
      const maxBytes = isFeed ? limits.maxFeedBytes : limits.maxBytes;
      if (isFeed && limits.declaredSize !== undefined && limits.declaredSize > limits.maxFeedBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(limits.maxFeedBytes, contentType, url, receivedBytes, "feed");
      }
      // If a response advertised a large ambiguous body but its first safe
      // prefix proves it is not a Feed, stop immediately instead of consuming
      // the remaining ordinary-page allowance.
      const largeNonFeed = !isFeed
        && limits.declaredSize !== undefined
        && limits.declaredSize > limits.maxBytes
        && prefixBytes >= FEED_SIGNATURE_SNIFF_BYTES;
      if (receivedBytes > maxBytes || largeNonFeed) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(maxBytes, contentType, url, receivedBytes, isFeed ? "feed" : "page");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return decodeChunks(chunks, receivedBytes);
}

function decodeChunks(chunks: Uint8Array[], byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function normalisedFeedByteLimit(options: PublicRequestOptions | undefined, maxBytes: number): number {
  if (options?.maxFeedBytes !== undefined) {
    return Number.isFinite(options.maxFeedBytes) && options.maxFeedBytes > 0
      ? Math.max(maxBytes, Math.floor(options.maxFeedBytes))
      : maxBytes;
  }
  // An explicit caller budget (for example article-date enrichment) remains
  // authoritative. Source/Feed discovery gets the larger bounded budget.
  return options?.maxBytes === undefined ? DEFAULT_FEED_DOCUMENT_MAX_BYTES : maxBytes;
}
