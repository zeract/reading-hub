import { assertPublicUrl } from "../shared/url";
import { abortError, awaitWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";
import { discardResponseBody, readResponseBytes } from "./byte-limit";
import { chromiumFetch } from "./network";

type CacheItem = { expiresAt: number; disallow: string[] };
const MAX_ROBOTS_BYTES = 1_048_576;

/** A crawler restriction, not a network or article-content failure. */
export class RobotsDisallowedError extends Error {
  constructor() {
    super("该站点的 robots.txt 不允许此路径被自动读取。");
    this.name = "RobotsDisallowedError";
  }
}

/** A truncated policy must never become permission to fetch its original page. */
class RobotsResponseTooLargeError extends RobotsDisallowedError {
  constructor() {
    super();
    this.name = "RobotsResponseTooLargeError";
    this.message = "该站点的 robots.txt 超过安全大小限制，已停止自动读取。";
  }
}

/** Small, conservative robots.txt checker. A failed robots request permits the fetch. */
export class RobotsPolicy {
  private readonly cache = new Map<string, CacheItem>();

  async assertAllowed(rawUrl: string, options?: { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options?.signal);
    const url = assertPublicUrl(rawUrl);
    const origin = url.origin;
    let item = this.cache.get(origin);
    if (!item || item.expiresAt < Date.now()) {
      item = await this.load(origin, options?.signal);
      throwIfAborted(options?.signal);
      this.cache.set(origin, item);
    }
    if (item.disallow.some((path) => path !== "" && (url.pathname + url.search).startsWith(path))) {
      throw new RobotsDisallowedError();
    }
  }

  private async load(origin: string, signal?: AbortSignal): Promise<CacheItem> {
    const request = withRequestTimeout(signal, 8_000, "robots.txt 请求超时。");
    try {
      let target = `${origin}/robots.txt`;
      for (let redirects = 0; redirects <= 5; redirects++) {
        let response: Response | undefined;
        try {
          throwIfAborted(request.signal);
          const fetching = chromiumFetch(target, {
            headers: { "User-Agent": "ReadingHub/0.1 (+local reader)" },
            redirect: "manual",
            signal: request.signal
          }).then((result) => {
            if (request.signal.aborted) discardResponseBody(result);
            throwIfAborted(request.signal);
            return result;
          });
          response = await awaitWithAbort(fetching, request.signal);
          const location = response.headers.get("location");
          if (location && response.status >= 300 && response.status < 400) {
            if (redirects === 5) throw new Error("robots.txt 重定向次数过多。");
            const redirected = assertPublicUrl(new URL(location, target).toString());
            if (new URL(target).protocol === "https:" && redirected.protocol !== "https:") {
              throw new Error("robots.txt 重定向地址不安全。");
            }
            target = redirected.toString();
            continue;
          }
          if (!response.ok) return { expiresAt: Date.now() + 24 * 60 * 60_000, disallow: [] };
          const declaredBytes = Number(response.headers.get("content-length"));
          if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ROBOTS_BYTES) throw new RobotsResponseTooLargeError();
          const bytes = await readResponseBytes(response, (_chunk, received) => {
            if (received > MAX_ROBOTS_BYTES) throw new RobotsResponseTooLargeError();
          }, request.signal);
          throwIfAborted(request.signal);
          return { expiresAt: Date.now() + 24 * 60 * 60_000, disallow: parseRobots(new TextDecoder().decode(bytes)) };
        } finally { discardResponseBody(response); }
      }
      throw new Error("robots.txt 重定向次数过多。");
    } catch (error) {
      // An explicit audit cancellation must not silently become a fail-open
      // robots result that permits the pending page request to continue.
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof RobotsResponseTooLargeError) throw error;
      return { expiresAt: Date.now() + 60 * 60_000, disallow: [] };
    } finally {
      request.dispose();
    }
  }
}

export function parseRobots(input: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") applies = value === "*" || value.toLowerCase() === "readinghub";
    if (key === "disallow" && applies) rules.push(value);
  }
  return rules;
}
