import { load } from "cheerio";
import { compactText, parsePublishedAt } from "../shared/text";
import { isZhihuBusinessPromotionUrl, toAbsoluteUrl } from "../shared/url";
import type { RawEntry } from "../shared/types";

// The Follow timeline also contains "想法" (/pin/) and question activity.
// They are intentionally not subscriptions in Reading Hub: only a followed
// author's published answer, column article, or video is collected.
const PUBLISHED_POST_LINK = /^(?:\/question\/\d+\/answer\/\d+|\/p\/\d+|\/zvideo\/\d+)/;

/** Extracts only published post cards from the rendered, user-authorized Follow feed. */
export function extractZhihuFollowPage(html: string, pageUrl = "https://www.zhihu.com/follow"): RawEntry[] {
  const $ = load(html);
  const roots = new Set<any>();
  for (const selector of [".TopstoryItem", ".FeedItem", ".ContentItem", "article"]) {
    $(selector).each((_index, element) => {
      roots.add(element);
    });
  }

  const entries: RawEntry[] = [];
  const seen = new Set<string>();
  for (const element of roots) {
    const root = $(element);
    const contentLinks = root
      .find("a[href]")
      .toArray()
      .map((node) => {
        const href = toAbsoluteUrl($(node).attr("href"), pageUrl);
        return { href, text: compactText($(node).text(), 240) };
      })
      .filter((link): link is { href: string; text: string | undefined } => Boolean(link.href && isZhihuContentUrl(link.href) && !isZhihuBusinessPromotionUrl(link.href)));
    if (!contentLinks.length) continue;
    contentLinks.sort((left, right) => linkScore(right) - linkScore(left));
    const contentLink = contentLinks[0];
    if (seen.has(contentLink.href)) continue;

    const heading = root.find("h1,h2,h3,[class*='Title'],[class*='title']").filter((_index, node) => {
      const text = compactText($(node).text(), 240);
      return Boolean(text && text.length >= 6);
    }).first();
    const headingText = compactText(heading.text(), 240);
    const title = headingText || contentLink.text || "知乎关注动态";
    const summaryNode = root
      .find(".RichContent-inner, .ContentItem-content, [class*='RichContent'] p, p")
      .filter((_index, node) => (compactText($(node).text(), 500)?.length ?? 0) >= 24)
      .first();
    const authorNode = root.find(".AuthorInfo-name, [class*='Author'] a[href*='/people/'], a[href*='/people/']").first();
    const imageNode = root.find("img").first();

    seen.add(contentLink.href);
    entries.push({
      url: contentLink.href,
      title,
      author: compactText(authorNode.text(), 120),
      summary: compactText(summaryNode.text(), 500),
      publishedAt: extractPublishedAt($, root),
      imageUrl: toAbsoluteUrl(imageNode.attr("data-actualsrc") || imageNode.attr("data-src") || imageNode.attr("src"), pageUrl)
    });
  }
  return entries;
}

function extractPublishedAt($: ReturnType<typeof load>, root: any): number | undefined {
  const directNodes = [
    root.get(0),
    ...root.find("time[datetime],[data-created-time],[data-created_time],[data-published-time],[data-published_time]").toArray(),
  ].filter(Boolean);
  for (const node of directNodes) {
    const value = $(node).attr("datetime") || $(node).attr("data-created-time") || $(node).attr("data-created_time") || $(node).attr("data-published-time") || $(node).attr("data-published_time");
    const timestamp = parseZhihuTimestamp(value);
    if (timestamp) return timestamp;
  }

  for (const node of [root.get(0), ...root.find("[data-za-extra-module],[data-zop]").toArray()].filter(Boolean)) {
    const timestamp = parseStructuredTimestamp($(node).attr("data-za-extra-module") || $(node).attr("data-zop"));
    if (timestamp) return timestamp;
  }

  const visibleTime = root.find("time,[class*='Time'],[class*='time']").toArray();
  for (const node of visibleTime) {
    const timestamp = parseZhihuTimestamp(compactText($(node).text(), 120));
    if (timestamp) return timestamp;
  }

  // Zhihu has also shipped timeline cards whose date is a plain span labelled
  // “发布于”, without a time-related class or data attribute. Restrict the
  // fallback to that explicit label so a date mentioned in the answer body is
  // never mistaken for the post's publication time.
  const labelledPublication = root.find("*").toArray().find((node: any) => /(?:发布|发表|创建|更新)(?:于|时间)?\s*20\d{2}[年./-]/.test(compactText($(node).text(), 120) || ""));
  if (labelledPublication) {
    const timestamp = parseZhihuTimestamp(compactText($(labelledPublication).text(), 120));
    if (timestamp) return timestamp;
  }
  return undefined;
}

function parseStructuredTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:created[_-]?(?:time|at)|published?[_-]?(?:time|at)|publish[_-]?time)["']?\s*[:=]\s*["']?(\d{10,13})/i);
  return parseUnixTimestamp(match?.[1]);
}

function parseZhihuTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const unix = parseUnixTimestamp(value);
  if (unix) return unix;
  // A card's `time[datetime]` is an ISO instant and may include an explicit
  // offset. Preserve the time of day instead of passing it through the
  // generic day-only parser used for RSS-style date labels.
  if (/^20\d{2}-\d{1,2}-\d{1,2}T/.test(value.trim())) {
    const iso = Date.parse(value);
    if (!Number.isNaN(iso)) return iso;
  }
  const chineseDateTime = value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (chineseDateTime) {
    const date = new Date(Number(chineseDateTime[1]), Number(chineseDateTime[2]) - 1, Number(chineseDateTime[3]), Number(chineseDateTime[4] ?? 0), Number(chineseDateTime[5] ?? 0));
    if (!Number.isNaN(date.getTime())) return date.getTime();
  }
  const direct = parsePublishedAt(value);
  if (direct) return direct;

  const relative = value.match(/(\d+)\s*(分钟|小时|天)前/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] === "分钟" ? 60_000 : relative[2] === "小时" ? 60 * 60_000 : 24 * 60 * 60_000;
    return Date.now() - amount * unit;
  }
  const timeOfDay = value.match(/(?:今天|昨日|昨天|前天)?\s*(\d{1,2}):(\d{2})/);
  if (timeOfDay) {
    const dayOffset = value.includes("前天") ? 2 : value.includes("昨天") || value.includes("昨日") ? 1 : 0;
    const date = new Date();
    date.setHours(Number(timeOfDay[1]), Number(timeOfDay[2]), 0, 0);
    date.setDate(date.getDate() - dayOffset);
    return date.getTime();
  }
  const monthDay = value.match(/(\d{1,2})[月/-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (monthDay) {
    const now = new Date();
    const date = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]), Number(monthDay[3] ?? 0), Number(monthDay[4] ?? 0));
    if (date.getTime() > Date.now() + 24 * 60 * 60_000) date.setFullYear(date.getFullYear() - 1);
    return date.getTime();
  }
  return undefined;
}

function parseUnixTimestamp(value?: string): number | undefined {
  if (!value || !/^\d{10,13}$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return value.trim().length === 10 ? number * 1_000 : number;
}

function linkScore(link: { href: string; text?: string }): number {
  const path = new URL(link.href).pathname;
  const answer = /\/answer\/\d+/.test(path) ? 5 : 0;
  const article = /^\/p\/\d+/.test(path) ? 4 : 0;
  const video = /^\/zvideo\//.test(path) ? 3 : 0;
  return answer + article + video + Math.min(link.text?.length ?? 0, 120) / 120;
}

function isZhihuContentUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.hostname === "www.zhihu.com" || url.hostname === "zhuanlan.zhihu.com") && PUBLISHED_POST_LINK.test(url.pathname);
  } catch {
    return false;
  }
}
