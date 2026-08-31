import type { Facet } from "../shared/types";
import { compactText } from "../shared/text";

/**
 * Feed and archive taxonomies describe labels local to one publisher. Keeping
 * the origin in the scheme prevents an unrelated publisher's "AI" category
 * from becoming the same selectable value as this publisher's "AI".
 */
export function publisherFacetScheme(pageUrl: string, kind: "category" | "tag"): string {
  const origin = new URL(pageUrl).origin.toLowerCase();
  return `feed:${origin}:${kind}`;
}

/**
 * Produces a stable local taxonomy key without attempting to translate or
 * globally classify publisher-owned labels. Unicode labels are intentionally
 * retained: they are valid SQLite/JSON strings and avoid lossy transliteration.
 */
export function canonicalFacetKey(value: string): string | undefined {
  const text = compactText(value.normalize("NFKC"), 180);
  if (!text) return undefined;
  const key = text
    .toLowerCase()
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

export function publisherFacet(
  pageUrl: string,
  kind: "category" | "tag",
  labelValue: string,
  keyValue = labelValue
): Facet | undefined {
  const label = compactText(labelValue, 120);
  const key = canonicalFacetKey(keyValue);
  if (!label || !key) return undefined;
  return { scheme: publisherFacetScheme(pageUrl, kind), key, label };
}

export function uniqueFacets(values: Array<Facet | undefined>): Facet[] {
  const result: Facet[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const identity = `${value.scheme}\u0000${value.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}
