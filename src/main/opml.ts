import { load } from "cheerio";

export type OpmlSubscription = {
  url: string;
  title?: string;
  category?: string;
};

/**
 * Parse the portable subscription subset of OPML. OPML folders are retained
 * as local source categories; no HTML, scripts, custom attributes, or file
 * references from the document are ever rendered or executed.
 */
export function parseOpml(text: string): OpmlSubscription[] {
  const $ = load(text, { xmlMode: true });
  if (!$('opml').length) throw new Error("这不是有效的 OPML 订阅文件。");

  const subscriptions: OpmlSubscription[] = [];
  $("outline").each((_index, node) => {
    const outline = $(node);
    const rawUrl = outline.attr("xmlUrl") || outline.attr("xmlurl");
    if (!rawUrl?.trim()) return;
    const title = compact(outline.attr("title") || outline.attr("text"));
    const category = categoryFor($, node);
    subscriptions.push({ url: rawUrl.trim(), title, category });
  });
  if (!subscriptions.length) throw new Error("OPML 中没有找到带 xmlUrl 的订阅。");
  return subscriptions;
}

function categoryFor($: ReturnType<typeof load>, node: Parameters<ReturnType<typeof load>>[0]): string | undefined {
  const labels = $(node).parents("outline").toArray().reverse()
    .map((parent) => compact($(parent).attr("title") || $(parent).attr("text")))
    .filter((label): label is string => Boolean(label));
  if (!labels.length) return undefined;
  // Source categories are intentionally short labels, not arbitrary document
  // text. Preserve the nearest folders if a deeply nested OPML exceeds it.
  return labels.join(" / ").slice(-60);
}

function compact(value: string | undefined): string | undefined {
  const result = value?.replace(/\s+/g, " ").trim();
  return result || undefined;
}
