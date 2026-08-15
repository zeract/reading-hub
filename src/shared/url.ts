import { createHash } from "node:crypto";

const TRACKING_PARAMS = ["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"];

export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    const normalized = rawUrl.trim().match(/^[a-z][a-z0-9+.-]*:/i) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    url = new URL(normalized);
  } catch {
    throw new Error("请输入有效的网址。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("仅允许公开 HTTP 或 HTTPS 地址。");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("不能添加本机或私有网络地址。");
  }
  return url;
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

export function contentHash(entry: { title: string; summary?: string; publishedAt?: number }): string {
  return createHash("sha256")
    .update(`${entry.title.trim()}\u0000${entry.publishedAt ?? ""}\u0000${entry.summary?.trim() ?? ""}`)
    .digest("hex");
}

export function toAbsoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return undefined;
  }
}
