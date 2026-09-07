import { assertPublicUrl } from "../shared/url";
import { abortError, throwIfAborted, withRequestTimeout } from "./cancellation";
import { discardResponseBody, readResponseBytes } from "./byte-limit";
import { chromiumFetch } from "./network";
import { isRobotsPathAllowed, parseRobots, type RobotsRule } from "./robots-rules";
import { fetchResponse } from "./fetch-response";
import { WeightedLruCache } from "./weighted-lru-cache";
import { SharedTaskMap } from "./shared-task-map";

type RobotsResult = { kind: "rules"; rules: RobotsRule[] } | { kind: "unavailable" } | { kind: "unreachable" };
type CacheItem = { expiresAt: number; result: RobotsResult };
const MAX_ROBOTS_BYTES = 1_048_576;
const POLICY_CACHE_MS = 24 * 60 * 60_000;
const FAILURE_RETRY_MS = 60 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_WEIGHT = 8 * 1_048_576;

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

class RobotsUnreachableError extends RobotsDisallowedError {
  constructor() {
    super();
    this.name = "RobotsUnreachableError";
    this.message = "暂时无法确认该站点的 robots.txt 规则，已停止自动读取，请稍后重试。";
  }
}

/** Retrieval state and parsed rules are distinct; an unknown policy is not permission. */
export class RobotsPolicy {
  private readonly cache = new WeightedLruCache<string, CacheItem>({
    maxEntries: MAX_CACHE_ENTRIES,
    maxWeight: MAX_CACHE_WEIGHT,
    expiresAt: (item) => item.expiresAt,
    // Budget retained UTF-16 strings plus per-rule/array overhead.
    weight: (origin, item) => 128 + origin.length * 2 + (item.result.kind === "rules"
      ? item.result.rules.reduce((total, rule) => total + 128 + rule.pattern.length * 2
        + rule.parts.reduce((size, part) => size + 32 + part.length * 2, 0), 0)
      : 0)
  });
  private readonly pending = new SharedTaskMap<CacheItem>();

  async assertAllowed(rawUrl: string, options?: { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options?.signal);
    const url = assertPublicUrl(rawUrl);
    if (url.pathname === "/robots.txt" && !url.search) return;
    const origin = url.origin;
    const item = this.cache.get(origin) ?? await this.pending.run(origin, async (signal) => {
      const loaded = await this.load(origin, signal);
      throwIfAborted(signal);
      this.cache.set(origin, loaded);
      return loaded;
    }, options?.signal);
    throwIfAborted(options?.signal);
    if (item.result.kind === "unreachable") throw new RobotsUnreachableError();
    if (item.result.kind === "rules" && !isRobotsPathAllowed(item.result.rules, url.pathname + url.search)) {
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
          response = await fetchResponse(chromiumFetch, target, {
            headers: { "User-Agent": "ReadingHub/0.1 (+local reader)" },
            redirect: "manual",
            signal: request.signal
          });
          throwIfAborted(request.signal);
          const location = response.headers.get("location");
          if (location && response.status >= 300 && response.status < 400) {
            if (redirects === 5) return { expiresAt: Date.now() + POLICY_CACHE_MS, result: { kind: "unavailable" } };
            const redirected = assertPublicUrl(new URL(location, target).toString());
            if (new URL(target).protocol === "https:" && redirected.protocol !== "https:") {
              throw new Error("robots.txt 重定向地址不安全。");
            }
            target = redirected.toString();
            continue;
          }
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            return { expiresAt: Date.now() + POLICY_CACHE_MS, result: { kind: "unavailable" } };
          }
          if (!response.ok) throw new RobotsUnreachableError();
          const declaredBytes = Number(response.headers.get("content-length"));
          if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ROBOTS_BYTES) throw new RobotsResponseTooLargeError();
          const bytes = await readResponseBytes(response, (_chunk, received) => {
            if (received > MAX_ROBOTS_BYTES) throw new RobotsResponseTooLargeError();
          }, request.signal);
          throwIfAborted(request.signal);
          return { expiresAt: Date.now() + POLICY_CACHE_MS, result: { kind: "rules", rules: parseRobots(new TextDecoder().decode(bytes)) } };
        } finally { discardResponseBody(response); }
      }
      throw new Error("robots.txt 重定向次数过多。");
    } catch (error) {
      // Caller cancellation must not become a cached site failure or trigger
      // the reader's policy fallback after the request has been abandoned.
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof RobotsResponseTooLargeError) throw error;
      return { expiresAt: Date.now() + FAILURE_RETRY_MS, result: { kind: "unreachable" } };
    } finally {
      request.dispose();
    }
  }
}
