import { assertPublicUrl } from "../shared/url";
import { abortError, throwIfAborted, withRequestTimeout } from "./cancellation";
import { chromiumFetch } from "./network";

type CacheItem = { expiresAt: number; disallow: string[] };

/** A crawler restriction, not a network or article-content failure. */
export class RobotsDisallowedError extends Error {
  constructor() {
    super("该站点的 robots.txt 不允许此路径被自动读取。");
    this.name = "RobotsDisallowedError";
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
      this.cache.set(origin, item);
    }
    if (item.disallow.some((path) => path !== "" && (url.pathname + url.search).startsWith(path))) {
      throw new RobotsDisallowedError();
    }
  }

  private async load(origin: string, signal?: AbortSignal): Promise<CacheItem> {
    const request = withRequestTimeout(signal, 8_000, "robots.txt 请求超时。");
    try {
      const response = await chromiumFetch(`${origin}/robots.txt`, {
        headers: { "User-Agent": "ReadingHub/0.1 (+local reader)" },
        signal: request.signal
      });
      if (!response.ok) return { expiresAt: Date.now() + 24 * 60 * 60_000, disallow: [] };
      return { expiresAt: Date.now() + 24 * 60 * 60_000, disallow: parseRobots(await response.text()) };
    } catch {
      // An explicit audit cancellation must not silently become a fail-open
      // robots result that permits the pending page request to continue.
      if (signal?.aborted) throw abortError(signal);
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
