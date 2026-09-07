import type { CheerioAPI } from "cheerio";

/** Resolve the first authored base href against the loaded document URL.
 * This is URL resolution, not permission to fetch: consumers must still
 * validate each resulting link or resource with their own access policy. */
export function htmlDocumentBaseUrl($: CheerioAPI, pageUrl: string): string {
  const href = $("base[href]").filter((_, node) => {
    // Cheerio's parents() stops at the template's document fragment. Walk
    // through that fragment to avoid treating inert markup as a live base.
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type === "tag" && parent.name === "template") return false;
    }
    return true;
  }).first().attr("href");
  if (href === undefined) return pageUrl;
  try {
    const base = new URL(href, pageUrl);
    // HTML ignores these schemes (and parse failures), without trying a
    // later base element. Other schemes still reach resource validation.
    return ["data:", "javascript:"].includes(base.protocol) ? pageUrl : base.toString();
  } catch {
    return pageUrl;
  }
}
