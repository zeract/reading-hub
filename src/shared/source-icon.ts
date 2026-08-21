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
 * Platform sources keep a deliberate local mark. Ordinary sites use their
 * own favicon, fetched by the main process rather than a third-party icon
 * service so the reader does not disclose a user's subscriptions elsewhere.
 */
export function sourceIconKind(source: Source): SourceIconKind {
  if (source.config?.sourceProvider === "rsshub") return source.config.rsshubPlatform === "xiaohongshu" ? "xiaohongshu" : "x";
  const host = sourceHostname(source.url);
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
  if (host === "www.zhihu.com" || host.endsWith(".zhihu.com")) return source.kind === "zhihu_follow" ? "zhihu-follow" : "zhihu";
  if (host.endsWith("xiaohongshu.com")) return "xiaohongshu";
  return iconKindBySource[source.kind];
}

/** Returns only a public same-site favicon URL; malformed and local sources use the local fallback. */
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
