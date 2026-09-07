import { assertFeedSubscriptionUrl, assertPublicUrl, isTrustedLoopbackFeedUrl } from "../shared/url";
import { abortError, throwIfAborted, withRequestTimeout } from "./cancellation";
import { concatenateBytes, discardResponseBody, formatByteLimit, readResponseBytes } from "./byte-limit";
import { hasFeedSignature, isAmbiguousFeedContentType, isExplicitFeedContentType } from "./feed";
import { chromiumFetch } from "./network";
import { RobotsPolicy } from "./robots";
import { fetchResponse } from "./fetch-response";
import { WeightedLruCache } from "./weighted-lru-cache";
import { SharedTaskMap } from "./shared-task-map";
import { TaskPool } from "./task-pool";
import { validatorResourceUrl } from "./response-validators";

export interface TextResponse {
  url: string;
  status: number;
  contentType: string;
  text: string;
  etag?: string;
  lastModified?: string;
}

/** Validators must identify the response representation they validate. */
export type TextValidators = Pick<TextResponse, "url" | "etag" | "lastModified">;

export interface PublicRequestOptions {
  maxBytes?: number;
  /** Original articles should negotiate HTML, not a DOI's JSON metadata. */
  preferHtml?: boolean;
  /**
   * Optional larger budget used only after a response has been verified as a
   * RSS/Atom/JSON Feed. Omit it to use the normal source-feed budget whenever
   * `maxBytes` is also omitted.
   */
  maxFeedBytes?: number;
  allowTrustedLoopbackFeed?: boolean;
  /** Optional caller-owned cancellation, shared by sync and reader work. */
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

  private readonly imageTasks = new SharedTaskMap<string>();
  private readonly imagePool = new TaskPool(4, 64);
  private readonly imageCache = new WeightedLruCache<string, string>({
    maxEntries: 24,
    maxWeight: 32 * 1_048_576,
    // Include both the referrer/image key and the encoded data URL at a
    // conservative UTF-16 cost, plus entry overhead. In-flight reads are separate.
    weight: (key, value) => 128 + (key.length + value.length) * 2
  });

  async getText(rawUrl: string, cached?: TextValidators, options?: PublicRequestOptions): Promise<TextResponse> {
    const maxBytes = options?.maxBytes ?? DEFAULT_SOURCE_DOCUMENT_MAX_BYTES;
    const maxFeedBytes = normalisedFeedByteLimit(options, maxBytes);
    const localFeed = options?.allowTrustedLoopbackFeed === true && isTrustedLoopbackFeedUrl(rawUrl);
    const localFeedOrigin = localFeed ? assertFeedSubscriptionUrl(rawUrl, true).origin : undefined;
    let targetUrl = localFeed ? assertFeedSubscriptionUrl(rawUrl, true).toString() : assertPublicUrl(rawUrl).toString();
    const baseHeaders: Record<string, string> = {
      "User-Agent": "ReadingHub/0.1 (+local reader)",
      Accept: options?.preferHtml
        ? "text/html, application/xhtml+xml;q=0.9, */*;q=0.1"
        : "application/atom+xml, application/rss+xml, application/feed+json, application/json, text/html;q=0.9, */*;q=0.1"
    };
    const cachedUrl = cached?.url ? validatorResourceUrl(cached.url) : undefined;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const headers = { ...baseHeaders };
      if (cachedUrl && cachedUrl === validatorResourceUrl(targetUrl)) {
        if (cached?.etag) headers["If-None-Match"] = cached.etag;
        if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
      }
      throwIfAborted(options?.signal);
      if (!localFeed) await this.robots.assertAllowed(targetUrl, { signal: options?.signal });
      const request = withRequestTimeout(options?.signal, 20_000, "该站点响应超时。请稍后重试，或检查网络与代理设置。");
      let response: Response | undefined;
      try {
        // Redirects are followed explicitly so every destination is checked for
        // public-address and robots policy compliance.
        try {
          response = await fetchResponse(chromiumFetch, targetUrl, { headers, redirect: "manual", signal: request.signal });
          throwIfAborted(request.signal);
        } catch (error) {
          if (options?.signal?.aborted) throw abortError(options.signal);
          throw new NetworkRequestError(error);
        }
        const location = response.headers.get("location");
        if (location && [301, 302, 303, 307, 308].includes(response.status)) {
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
        const validators = {
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined
        };
        if (response.status === 304) {
          if (!headers["If-None-Match"] && !headers["If-Modified-Since"]) {
            throw new Error("站点在未收到有效条件请求时返回了 304，无法确认内容未变化，请稍后重试。");
          }
          return { url: targetUrl, status: 304, contentType: response.headers.get("content-type") ?? "", text: "", ...validators };
        }
        if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
        const contentType = response.headers.get("content-type") ?? "";
        const declaredSize = Number(response.headers.get("content-length") ?? 0);
        const feedCandidate = isExplicitFeedContentType(contentType) || isAmbiguousFeedContentType(contentType);
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes && !feedCandidate) {
          // A declared size lets us reject before creating a body reader. Tell
          // Chromium to stop consuming the response so a preview cannot keep
          // an unnecessarily large transfer alive in the background.
          throw new ResponseTooLargeError(maxBytes, contentType, targetUrl, declaredSize);
        }
        try {
          const text = await readTextWithinLimit(response, {
            maxBytes,
            maxFeedBytes,
            declaredSize: Number.isFinite(declaredSize) ? declaredSize : undefined
          }, contentType, targetUrl, request.signal);
          throwIfAborted(request.signal);
          return {
            url: targetUrl,
            status: response.status,
            contentType,
            text,
            ...validators
          };
        } catch (error) {
          if (error instanceof ResponseTooLargeError) throw error;
          if (options?.signal?.aborted) throw abortError(options.signal);
          throw new NetworkRequestError(error);
        }
      } finally {
        discardResponseBody(response);
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
    const targetUrl = assertPublicUrl(rawUrl).toString();
    const cacheKey = `${referrer}\u0000${targetUrl}`;
    const cached = this.imageCache.get(cacheKey);
    if (cached) return cached;
    return this.imageTasks.run(cacheKey, (signal) => this.imagePool.run(async () => {
      const result = await this.downloadImage(targetUrl, referrer, signal);
      throwIfAborted(signal);
      this.imageCache.set(cacheKey, result);
      return result;
    }, signal), options?.signal);
  }

  private async downloadImage(targetUrl: string, referrer: string, signal: AbortSignal): Promise<string> {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      throwIfAborted(signal);
      await this.robots.assertAllowed(targetUrl, { signal });
      const request = withRequestTimeout(signal, 20_000, "图片请求超时。请稍后重试，或检查网络与代理设置。");
      let response: Response | undefined;
      try {
        try {
          response = await fetchResponse(chromiumFetch, targetUrl, {
            headers: {
              "User-Agent": "ReadingHub/0.1 (+local reader)",
              Accept: "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/x-icon,image/vnd.microsoft.icon;q=0.9,*/*;q=0.1"
            },
            redirect: "manual",
            referrer,
            referrerPolicy: "strict-origin-when-cross-origin",
            signal: request.signal
          });
          throwIfAborted(request.signal);
        } catch (error) {
          if (signal.aborted) throw abortError(signal);
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
        const bytes = Buffer.from(await readResponseBytes(response, (_chunk, receivedBytes) => {
          if (receivedBytes > maxBytes) throw new Error("图片响应超过 8 MB，已跳过加载。");
        }, request.signal));
        throwIfAborted(request.signal);
        return `data:${contentType};base64,${bytes.toString("base64")}`;
      } finally {
        discardResponseBody(response);
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
async function readTextWithinLimit(response: Response, limits: TextByteLimits, contentType: string, url: string, signal?: AbortSignal): Promise<string> {
  const prefixChunks: Uint8Array[] = [];
  let prefixBytes = 0;
  const mayBeFeed = isExplicitFeedContentType(contentType) || isAmbiguousFeedContentType(contentType);
  let isFeed = false;
  const bytes = await readResponseBytes(response, (value, receivedBytes) => {
    if (mayBeFeed && prefixBytes < FEED_SIGNATURE_SNIFF_BYTES) {
      const remaining = FEED_SIGNATURE_SNIFF_BYTES - prefixBytes;
      const prefix = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      prefixChunks.push(prefix);
      prefixBytes += prefix.byteLength;
      if (hasFeedSignature(decodeChunks(prefixChunks, prefixBytes))) isFeed = true;
    }
    const maxBytes = isFeed ? limits.maxFeedBytes : limits.maxBytes;
    if (isFeed && limits.declaredSize !== undefined && limits.declaredSize > limits.maxFeedBytes) {
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
      throw new ResponseTooLargeError(maxBytes, contentType, url, receivedBytes, isFeed ? "feed" : "page");
    }
  }, signal);
  return new TextDecoder().decode(bytes);
}

function decodeChunks(chunks: Uint8Array[], byteLength: number): string {
  return new TextDecoder().decode(concatenateBytes(chunks, byteLength));
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
