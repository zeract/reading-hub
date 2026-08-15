import { assertPublicUrl } from "../shared/url";
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

  async assertAllowed(rawUrl: string): Promise<void> {
    const url = assertPublicUrl(rawUrl);
    const origin = url.origin;
    let item = this.cache.get(origin);
    if (!item || item.expiresAt < Date.now()) {
      item = await this.load(origin);
      this.cache.set(origin, item);
    }
    if (item.disallow.some((path) => path !== "" && (url.pathname + url.search).startsWith(path))) {
      throw new RobotsDisallowedError();
    }
  }

  private async load(origin: string): Promise<CacheItem> {
    try {
      const response = await chromiumFetch(`${origin}/robots.txt`, {
        headers: { "User-Agent": "ReadingHub/0.1 (+local reader)" },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) return { expiresAt: Date.now() + 24 * 60 * 60_000, disallow: [] };
      return { expiresAt: Date.now() + 24 * 60 * 60_000, disallow: parseRobots(await response.text()) };
    } catch {
      return { expiresAt: Date.now() + 60 * 60_000, disallow: [] };
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
