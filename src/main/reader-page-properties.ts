import type { CheerioAPI } from "cheerio";

const PANEL_HINT = /(?:^|[-_])(?:page[-_])?(?:properties|metadata)(?:[-_]|$)/i;
const ROW_HINT = /(?:^|[-_])(?:(?:collection[-_])?row[-_])?(?:property|metadata|field)(?:[-_]|$)/i;
const LABEL_HINT = /(?:^|[-_])(?:(?:column|field)[-_])?(?:title|label|name|key)(?:[-_]|$)/i;
const VALUE_HINT = /(?:^|[-_])(?:(?:row|field)[-_])?(?:value|content)(?:[-_]|$)/i;
const CHROME_HINT = /(?:^|[-_])(?:header|title|meta|byline|breadcrumb)(?:[-_]|$)/i;
const MINIMUM_PROPERTY_ROWS = 2;

/**
 * A CMS may render its page-level database fields immediately before the
 * article blocks. Once origin CSS is intentionally discarded, its nested
 * label/value divs become misleading reader paragraphs. Remove only panels
 * that provide a complete structural proof: a page-properties/metadata
 * container, repeated labelled property rows, and a position before authored
 * content. Ordinary tables and in-article key/value explanations remain.
 */
export function removeLeadingPagePropertyPanels($: CheerioAPI, roots: any): void {
  // A full page can have nested `main`/`article` shells. Assess each one as
  // its own leading-content boundary; using the first root for every panel
  // would let unrelated site chrome incorrectly disqualify a true preamble.
  for (const rootNode of roots.toArray()) {
    const root = $(rootNode);
    const panels = root.find("[class], [id], [data-component], [data-kind], [data-role]").toArray()
      .filter((node: any) => isPropertyPanel($, $(node), root));
    for (const panel of panels) $(panel).remove();
  }
}

function isPropertyPanel($: CheerioAPI, panel: any, root: any): boolean {
  if (!hasHint(panel, PANEL_HINT)) return false;
  const rows = panel.find("[class], [data-component], [data-kind], [data-role]").toArray()
    .filter((node: any) => isPropertyRow($, $(node)));
  return rows.length >= MINIMUM_PROPERTY_ROWS && isLeadingPanel($, panel, root);
}

function isPropertyRow($: CheerioAPI, row: any): boolean {
  if (!hasHint(row, ROW_HINT)) return false;
  const children = row.find("[class], [data-component], [data-kind], [data-role]").toArray();
  return children.some((node: any) => hasHint($(node), LABEL_HINT))
    && children.some((node: any) => hasHint($(node), VALUE_HINT));
}

function hasHint(element: any, pattern: RegExp): boolean {
  return ["class", "id", "data-component", "data-kind", "data-role"]
    .map(name => String(element.attr(name) || ""))
    .some(value => pattern.test(value));
}

/** A panel after an actual prose/media block is part of authored content. */
function isLeadingPanel($: CheerioAPI, panel: any, root: any): boolean {
  for (let cursor = panel; cursor.length && cursor.get(0) !== root.get(0); cursor = cursor.parent()) {
    if (cursor.prevAll().toArray().some((node: any) => isSubstantiveSibling($(node)))) return false;
  }
  return true;
}

function isSubstantiveSibling(element: any): boolean {
  const tag = String(element.get(0)?.tagName || "").toLowerCase();
  if (["header", "h1", "h2", "h3", "h4", "h5", "h6", "nav"].includes(tag) || hasHint(element, CHROME_HINT)) return false;
  if (!normalText(element.text())) return false;
  return element.is("p, li, blockquote, pre, table, figure, img, video")
    || element.find("p, li, blockquote, pre, table, figure, img, video").length > 0
    || normalText(element.text()).length >= 80;
}

function normalText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
