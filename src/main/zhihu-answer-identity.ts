import type { CheerioAPI } from "cheerio";

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
  const direct = root.attr("data-answer-id");
  if (direct && /^\d+$/.test(direct)) return direct;
  try {
    const value = JSON.parse(root.attr("data-zop") || "{}");
    if (value.type === "answer" && /^\d+$/.test(String(value.itemId))) return String(value.itemId);
  } catch { /* Malformed remote metadata is not identity evidence. */ }
  const ids = new Set(root.find('meta[itemprop="url"], a[name]').toArray().flatMap((element) => {
    const value = $(element).attr("content") || $(element).attr("name") || "";
    const id = zhihuAnswerId(value);
    return id ? [id] : [];
  }));
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Return only a proven answer subtree; whole-page Readability is unsafe here. */
export function selectZhihuAnswer($: CheerioAPI, pageUrl: string): string | undefined {
  const expected = zhihuAnswerId(pageUrl);
  if (!expected) return undefined;
  const roots = $('.AnswerItem, [data-answer-id], [data-zop]').toArray()
    .filter(node => answerIdFromElement($, node) === expected);
  const root = roots.find(node => !$(node).parents().toArray().some(parent => roots.includes(parent)));
  if (root) {
    const selected = $(root).clone();
    selected.find('.AnswerItem, [data-answer-id], [data-zop]').filter((_index, node) => {
      const id = answerIdFromElement($, node);
      return Boolean(id && id !== expected) || ($(node).hasClass('AnswerItem') && !id);
    }).remove();
    return $.html(selected);
  }
  const canonical = $('link[rel="canonical"]').attr('href');
  const answers = $('.AnswerItem, .QuestionAnswer-content').toArray();
  const conflictingAnswer = $('.AnswerItem, [data-answer-id], [data-zop]').toArray().some(node => {
    const id = answerIdFromElement($, node);
    return id && id !== expected;
  });
  if (canonical && zhihuAnswerId(canonical) === expected && answers.length === 1 && !conflictingAnswer && !answerIdFromElement($, answers[0])) return $.html(answers[0]);
  throw new Error("未能确认目标知乎回答的身份，已停止提取以避免显示其他回答；请在原文中查看。");
}
