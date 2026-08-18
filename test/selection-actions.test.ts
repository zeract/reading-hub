import { describe, expect, it } from "vitest";
import { MAX_SELECTED_ARTICLE_TEXT, normaliseSelectedArticleText, selectionActionQuestion, selectionContext } from "../src/renderer/selection-actions";

describe("reader selected-text actions", () => {
  it("normalises a bounded article selection and makes explicit contextual tasks", () => {
    expect(normaliseSelectedArticleText("  一段\n\n选中的文字  ")).toBe("一段 选中的文字");
    expect(normaliseSelectedArticleText(" ")).toBeUndefined();
    expect(normaliseSelectedArticleText("a".repeat(MAX_SELECTED_ARTICLE_TEXT + 10))).toHaveLength(MAX_SELECTED_ARTICLE_TEXT);
    expect(selectionActionQuestion("translate")).toContain("翻译");
    expect(selectionActionQuestion("explain")).toContain("全文");
    expect(selectionActionQuestion("ask", "  这一步为什么成立？ ")).toBe("这一步为什么成立？");
    expect(selectionContext("片段", "ask")).toEqual({ text: "片段", intent: "ask" });
  });
});
