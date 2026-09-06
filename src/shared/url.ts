const TRACKING_PARAMS = ["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"];

export function assertPublicUrl(rawUrl: string): URL {
  const url = parseHttpUrl(rawUrl);
  const host = normalizedHost(url.hostname);
  if (isLoopbackHost(host) || host.endsWith(".localhost") || host.endsWith(".local") || isNonPublicAddress(host)) {
    throw new Error("不能添加本机或私有网络地址。");
  }
  return url;
}

/**
 * A loopback feed is an explicit user-owned input, not a general local-web
 * exception. It lets a local RSS service be consumed as a feed while keeping
 * generic webpage extraction, private-network access, and redirect escapes
 * outside the supported surface.
 */
export function isTrustedLoopbackFeedUrl(rawUrl: string): boolean {
  try {
    const url = parseHttpUrl(rawUrl);
    return isLoopbackHost(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Used only by the RSS connector and OPML import. Callers must still verify
 * the response is a real feed before persisting it as a local subscription.
 */
export function assertFeedSubscriptionUrl(rawUrl: string, allowTrustedLoopbackFeed = false): URL {
  const url = parseHttpUrl(rawUrl);
  if (allowTrustedLoopbackFeed && isLoopbackHost(url.hostname.toLowerCase())) return url;
  return assertPublicUrl(url.toString());
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    const normalized = rawUrl.trim().match(/^[a-z][a-z0-9+.-]*:/i) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    url = new URL(normalized);
  } catch {
    throw new Error("请输入有效的网址。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("仅允许公开 HTTP 或 HTTPS 地址。");
  if (url.username || url.password) throw new Error("网址不能包含用户名或密码，请使用授权连接。");
  return url;
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

function isLoopbackHost(host: string): boolean {
  // URL.hostname retains brackets for an IPv6 literal in Chromium/Node, so
  // treat both representations as the same loopback address.
  host = normalizedHost(host);
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Literal/local-name checks only; this does not resolve or pin DNS answers. */
function isNonPublicAddress(host: string): boolean {
  // WHATWG URL has already canonicalised alternate IPv4 spellings and
  // validated IPv6 syntax. Keep this shared helper usable in the renderer.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isNonPublicIpv4(host.split(".").map(Number));
  if (!host.startsWith("[")) return false;
  const [left, right] = host.slice(1, -1).split("::");
  const before = left ? left.split(":").map((word) => parseInt(word, 16)) : [];
  const after = right ? right.split(":").map((word) => parseInt(word, 16)) : [];
  const words = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill(0), ...after];
  // IPv4-mapped addresses must obey the same boundary as native IPv4.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isNonPublicIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  }
  // Includes unspecified/loopback and the deprecated IPv4-compatible range.
  return words.slice(0, 6).every((word) => word === 0)
    || (words[0] & 0xfe00) === 0xfc00 // unique-local
    || (words[0] & 0xffc0) === 0xfe80 // link-local
    || (words[0] & 0xffc0) === 0xfec0 // deprecated site-local
    || (words[0] & 0xff00) === 0xff00; // multicast
}

function isNonPublicIpv4([first, second]: number[]): boolean {
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

/**
 * Canonicalises a URL used to identify a collected content item. Most URLs
 * use the normal tracking-parameter policy. A Scour RSS item's
 * `/r/rss/<encoded upstream URL>` path is its identity, while query
 * parameters appended to that wrapper are per-delivery redirect state.
 */
export function canonicalizeContentUrl(rawUrl: string): string {
  const url = new URL(canonicalizeUrl(rawUrl));
  if (isScourRssRedirectUrl(url)) url.search = "";
  return url.toString();
}

export function isScourRssRedirectUrl(rawUrl: URL | string): boolean {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    return url.hostname.toLowerCase() === "scour.ing" && /^\/r\/rss\//.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Zhihu uses `spu=biz=…` on promoted cards in its Follow timeline. Those are
 * campaign referrals, rather than posts published by a followed author.
 */
export function isZhihuBusinessPromotionUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "www.zhihu.com" && host !== "zhuanlan.zhihu.com") return false;
    return (url.searchParams.get("spu") ?? "").trim().toLowerCase().startsWith("biz=");
  } catch {
    return false;
  }
}

/**
 * Returns whether a URL is a navigation/taxonomy destination rather than an
 * individual content URL.  Most taxonomy namespaces remain taxonomy below
 * their root (for example `/tags/llm`), but `archive`/`archives` are an
 * important exception: some publishers, including Scientific Spaces, use
 * `/archives/<article-id>` as their canonical article URL.  Treat only the
 * archive landing path itself as navigation so a source detector or one-time
 * cleanup cannot silently discard those real articles.
 */
export function isTaxonomyUrl(rawUrl: string): boolean {
  try {
    const segments = new URL(rawUrl).pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    const taxonomyIndex = segments.findIndex((segment) => /^(?:tag|tags|category|categories|taxonomy|archive|archives)$/.test(segment));
    if (taxonomyIndex < 0) return false;
    const taxonomy = segments[taxonomyIndex];
    if (taxonomy === "archive" || taxonomy === "archives") return taxonomyIndex === segments.length - 1;
    return true;
  } catch {
    return false;
  }
}

export function toAbsoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return undefined;
  }
}
