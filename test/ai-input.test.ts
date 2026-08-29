import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_AI_ARTICLE_TEXT_LENGTH,
  MAX_AI_ARTICLE_TITLE_LENGTH,
  MAX_AI_ARTICLE_RAW_TEXT_LENGTH,
  MAX_AI_SOURCE_TITLE_LENGTH,
  normaliseAiArticleText
} from "../src/shared/ai-input";
import { buildAiArticleContext, collectAiArticleText } from "../src/renderer/ai-request";

describe("AI article IPC input", () => {
  it("bounds and normalises article context before either renderer AI entry point sends it", () => {
    const context = buildAiArticleContext({
      title: `  ${"题".repeat(MAX_AI_ARTICLE_TITLE_LENGTH + 12)}  `,
      url: "https://example.com/very-long-article",
      sourceTitle: ` ${"源".repeat(MAX_AI_SOURCE_TITLE_LENGTH + 9)} `,
      plainText: `\n${"正文 ".repeat(MAX_AI_ARTICLE_TEXT_LENGTH + 20)}\n`
    });

    expect(context.title).toHaveLength(MAX_AI_ARTICLE_TITLE_LENGTH);
    expect(context.sourceTitle).toHaveLength(MAX_AI_SOURCE_TITLE_LENGTH);
    expect(context.text.length).toBeLessThanOrEqual(MAX_AI_ARTICLE_TEXT_LENGTH);
    expect(context.text.length).toBeGreaterThan(MAX_AI_ARTICLE_TEXT_LENGTH - 4);
    expect(context.text).not.toMatch(/\s{2,}/);
    expect(normaliseAiArticleText("  一段\n正文  ")).toBe("一段 正文");
  });

  it("bounds raw DOM text before normalisation instead of allocating a whole long article", () => {
    const text = collectAiArticleText(["前言 ", "x".repeat(MAX_AI_ARTICLE_RAW_TEXT_LENGTH * 2), "不应收集"]);
    expect(text).toHaveLength(MAX_AI_ARTICLE_RAW_TEXT_LENGTH);
    expect(text).toMatch(/^前言 /);
    expect(text).not.toContain("不应收集");
  });

  it("omits article context for translation while retaining the shared full-context path for questions", () => {
    const reader = readFileSync(resolve(process.cwd(), "src", "renderer", "reader-view.tsx"), "utf8");
    expect(reader).toContain('selection?.intent === "translate"');
    expect(reader).toContain('if (selection?.intent === "translate") return {};');
    expect([...reader.matchAll(/\.\.\.articlePayloadForAiRequest\(article, sourceTitle,/g)]).toHaveLength(2);
    expect(reader).toContain("collectAiArticleText(textNodeValues(document.body))");
    expect(reader).not.toContain("document.body.textContent");
  });
});
