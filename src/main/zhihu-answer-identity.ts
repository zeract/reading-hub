import type { CheerioAPI } from "cheerio";

/**
 * A verified answer must be reduced to its authored prose, not its outer card.
 * This selector is shared by reader extraction and the authorised-session
 * readiness check so a page cannot be declared ready for a different subtree
 * than the one the reader will later render.
 */
export const ZHIHU_AUTHORED_PROSE_SELECTOR = ".Post-RichTextContainer, .RichContent-inner, .RichText";

// These are unambiguous discussion roots. `CommentItem` alone cannot be used
// here because Zhihu also applies it to annotations around an author's own
// text; the reader's fuller structural cleanup handles that distinction.
const ZHIHU_DISCUSSION_ROOT_SELECTOR = "#comment, #comments, #comment-list, #commentlist, [class*='CommentList'], [class*='CommentsV2']";

export function zhihuAnswerId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com") return undefined;
    return url.pathname.match(/^\/question\/\d+\/answer\/(\d+)\/?$/)?.[1];
  } catch { return undefined; }
}

export function assertAnswerNavigation(requested: string, actual: string): void {
  const expected = zhihuAnswerId(requested);
  if (expected && zhihuAnswerId(actual) !== expected) throw new Error("知乎页面已跳转，无法确认目标回答；请在原文中查看。");
}

export function answerIdFromElement($: CheerioAPI, node: any): string | undefined {
  const root = $(node);
  const direct = root.attr("data-answer-id")?.trim();
  if (direct && /^\d+$/.test(direct)) return direct;
  try {
    // Zhihu's JSON metadata can expose a 19-digit answer ID as an unquoted
    // JSON number. JSON.parse would round it before String() sees it, making
    // a real target answer look like a different answer. Quote only this
    // declared numeric field before parsing, so the original digit sequence
    // remains the identity while the surrounding object is still validated.
    const raw = root.attr("data-zop") || "{}";
    const value = JSON.parse(raw.replace(/("itemId"\s*:\s*)((?:0|[1-9]\d*))(?=\s*[,}])/g, "$1\"$2\""));
    if (value.type === "answer" && /^\d+$/.test(String(value.itemId))) return String(value.itemId);
  } catch { /* Malformed remote metadata is not identity evidence. */ }
  const ids = new Set(root.find('meta[itemprop="url"], a[name]').toArray().flatMap((element) => {
    const value = $(element).attr("content") || $(element).attr("name") || "";
    const id = zhihuAnswerId(value);
    return id ? [id] : [];
  }));
  return ids.size === 1 ? [...ids][0] : undefined;
}

function verifiedAnswerRoot($: CheerioAPI, pageUrl: string): any | undefined {
  const expected = zhihuAnswerId(pageUrl);
  if (!expected) return undefined;
  const roots = $('.AnswerItem, [data-answer-id], [data-zop]').toArray()
    .filter(node => answerIdFromElement($, node) === expected);
  const root = roots.find(node => !$(node).parents().toArray().some(parent => roots.includes(parent)));
  if (root) return root;

  const canonical = $('link[rel="canonical"]').attr("href");
  const answers = $('.AnswerItem, .QuestionAnswer-content').toArray();
  const conflictingAnswer = $('.AnswerItem, [data-answer-id], [data-zop]').toArray().some(node => {
    const id = answerIdFromElement($, node);
    return id && id !== expected;
  });
  if (canonical && zhihuAnswerId(canonical) === expected && answers.length === 1 && !conflictingAnswer && !answerIdFromElement($, answers[0])) return answers[0];
  return undefined;
}

export type ZhihuAnswerContentReadiness = "ready" | "pending" | "unresolved";

/**
 * Distinguish a known answer shell still hydrating from a page whose identity
 * cannot yet be established. The latter remains for the strict extractor to
 * report rather than being mistaken for a valid short answer.
 */
export function zhihuAnswerContentReadiness($: CheerioAPI, pageUrl: string): ZhihuAnswerContentReadiness {
  if (!zhihuAnswerId(pageUrl)) return "ready";
  const root = verifiedAnswerRoot($, pageUrl);
  if (!root) return "unresolved";
  const answer = $(root);
  const authoredRoots = answer.is(ZHIHU_AUTHORED_PROSE_SELECTOR)
    ? answer
    : answer.find(ZHIHU_AUTHORED_PROSE_SELECTOR);
  const authoredProse = authoredRoots.filter((_index, node) => {
    const element = $(node);
    return !element.is(ZHIHU_DISCUSSION_ROOT_SELECTOR) && !element.parents(ZHIHU_DISCUSSION_ROOT_SELECTOR).length;
  });
  if (!authoredProse.length) return "pending";
  // A RichContent root is allowed to contain its discussion subtree. Remove
  // that subtree while checking readiness, otherwise a long comment would
  // falsely make an empty answer look hydrated.
  return authoredProse.toArray().some((node) => {
    const prose = $(node).clone();
    prose.find(ZHIHU_DISCUSSION_ROOT_SELECTOR).remove();
    return prose.text().replace(/\s+/g, "").length > 0;
  })
    ? "ready"
    : "pending";
}

/** Return only a proven answer subtree; whole-page Readability is unsafe here. */
export function selectZhihuAnswer($: CheerioAPI, pageUrl: string): string | undefined {
  const expected = zhihuAnswerId(pageUrl);
  if (!expected) return undefined;
  const root = verifiedAnswerRoot($, pageUrl);
  if (root) {
    const selected = $(root).clone();
    selected.find('.AnswerItem, [data-answer-id], [data-zop]').filter((_index, node) => {
      const id = answerIdFromElement($, node);
      return Boolean(id && id !== expected) || ($(node).hasClass('AnswerItem') && !id);
    }).remove();
    return $.html(selected);
  }
  throw new Error("未能确认目标知乎回答的身份，已停止提取以避免显示其他回答；请在原文中查看。");
}
