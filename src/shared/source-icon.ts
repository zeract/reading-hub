import type { Source } from "./types";
import { assertPublicUrl } from "./url";

export type SourceIconKind = "rss" | "web" | "link" | "zhihu" | "zhihu-follow" | "x" | "xiaohongshu" | "academic";

const iconKindBySource: Record<Source["kind"], SourceIconKind> = {
  rss: "rss",
  generic: "web",
  manual: "link",
  zhihu: "zhihu",
  zhihu_follow: "zhihu-follow",
  x: "x",
  xiaohongshu: "xiaohongshu",
  academic: "academic"
};

/**
 * Platform sources retain their category for local styling. Ordinary sites
 * use their own favicon, fetched by the main process rather than a third-party icon
 * service so the reader does not disclose a user's subscriptions elsewhere.
 */
export function sourceIconKind(source: Source): SourceIconKind {
  if (source.config?.sourceProvider === "rsshub") return source.config.rsshubPlatform === "xiaohongshu" ? "xiaohongshu" : "x";
  const host = sourceHostname(source.url);
  if (belongsToDomain(host, "x.com") || belongsToDomain(host, "twitter.com")) return "x";
  if (belongsToDomain(host, "zhihu.com")) return source.kind === "zhihu_follow" ? "zhihu-follow" : "zhihu";
  if (belongsToDomain(host, "xiaohongshu.com")) return "xiaohongshu";
  return iconKindBySource[source.kind];
}

/** Returns a public declared icon or same-site favicon; malformed and local sources use the local fallback. */
export function sourceFaviconCandidate(source: Source): string | undefined {
  if (source.iconUrl) {
    try {
      return assertPublicUrl(source.iconUrl).toString();
    } catch {
      // A stale or malformed feed icon cannot replace the safe local fallback.
    }
  }
  const kind = sourceIconKind(source);
  if (kind !== "rss" && kind !== "web") return undefined;
  try {
    const sourceUrl = assertPublicUrl(source.url);
    return new URL("/favicon.ico", sourceUrl.origin).toString();
  } catch {
    return undefined;
  }
}

function sourceHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function belongsToDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
