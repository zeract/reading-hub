import { assertPublicUrl } from "../shared/url";
import { abortError, awaitWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";
import { discardResponseBody, readResponseBytes } from "./byte-limit";
import { chromiumFetch } from "./network";
import { isRobotsPathAllowed, parseRobots, type RobotsRule } from "./robots-rules";

type RobotsResult = { kind: "rules"; rules: RobotsRule[] } | { kind: "unavailable" } | { kind: "unreachable" };
type CacheItem = { expiresAt: number; result: RobotsResult };
type PendingPolicy = { controller: AbortController; promise: Promise<CacheItem>; waiters: number; finished: boolean };
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
  private readonly cache = new Map<string, { item: CacheItem; weight: number }>();
  private cacheWeight = 0;
  private readonly pending = new Map<string, PendingPolicy>();

  async assertAllowed(rawUrl: string, options?: { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options?.signal);
    const url = assertPublicUrl(rawUrl);
    if (url.pathname === "/robots.txt" && !url.search) return;
    const origin = url.origin;
    this.pruneExpired();
    const cached = this.cache.get(origin);
    if (cached) {
      this.cache.delete(origin);
      this.cache.set(origin, cached);
    }
    const item = cached?.item ?? await this.joinLoad(origin, options?.signal);
    throwIfAborted(options?.signal);
    if (item.result.kind === "unreachable") throw new RobotsUnreachableError();
    if (item.result.kind === "rules" && !isRobotsPathAllowed(item.result.rules, url.pathname + url.search)) {
      throw new RobotsDisallowedError();
    }
  }

  private async joinLoad(origin: string, signal?: AbortSignal): Promise<CacheItem> {
    let task = this.pending.get(origin);
    if (!task) {
      const controller = new AbortController();
      const created: PendingPolicy = {
        controller, waiters: 0, finished: false,
        // Register the task and its first waiter before starting network work.
        promise: Promise.resolve().then(() => this.load(origin, controller.signal)).then((item) => {
          throwIfAborted(controller.signal);
          this.remember(origin, item);
          return item;
        }).finally(() => {
          created.finished = true;
          if (this.pending.get(origin) === created) this.pending.delete(origin);
        })
      };
      task = created;
      this.pending.set(origin, task);
    }
    task.waiters++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      task.waiters--;
      if (!task.waiters && !task.finished) {
        if (this.pending.get(origin) === task) this.pending.delete(origin);
        task.controller.abort();
      }
    };
    // Release synchronously on cancellation so a late success cannot enter
    // the cache between the last caller's abort and its Promise continuation.
    signal?.addEventListener("abort", release, { once: true });
    if (signal?.aborted) release();
    try { return await awaitWithAbort(task.promise, signal); }
    finally { release(); }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [origin, cached] of this.cache) {
      if (cached.item.expiresAt <= now) this.forget(origin);
    }
  }

  private forget(origin: string): void {
    const cached = this.cache.get(origin);
    if (!cached) return;
    this.cacheWeight -= cached.weight;
    this.cache.delete(origin);
  }

  private remember(origin: string, item: CacheItem): void {
    this.pruneExpired();
    this.forget(origin);
    // Budget retained UTF-16 strings plus per-rule/array overhead. This is an
    // accounting bound, not a claim about exact V8 heap allocation.
    const weight = 128 + origin.length * 2 + (item.result.kind === "rules"
      ? item.result.rules.reduce((total, rule) => total + 128 + rule.pattern.length * 2
        + rule.parts.reduce((size, part) => size + 32 + part.length * 2, 0), 0)
      : 0);
    if (weight > MAX_CACHE_WEIGHT) return; // Still apply this policy to its current callers.
    this.cache.set(origin, { item, weight });
    this.cacheWeight += weight;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cacheWeight > MAX_CACHE_WEIGHT) {
      this.forget(this.cache.keys().next().value!);
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
