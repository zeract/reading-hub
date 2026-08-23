import { describe, expect, it } from "vitest";
import { MAX_AI_SELECTION_TEXT_LENGTH } from "../src/shared/ai-input";
import { normaliseSelectedArticleText, selectionActionQuestion, selectionContext, selectionOverlay } from "../src/renderer/selection-actions";

describe("reader selected-text actions", () => {
  it("normalises a bounded article selection and makes explicit contextual tasks", () => {
    expect(normaliseSelectedArticleText("  一段\n\n选中的文字  ")).toBe("一段 选中的文字");
    expect(normaliseSelectedArticleText(" ")).toBeUndefined();
    expect(normaliseSelectedArticleText("a".repeat(MAX_AI_SELECTION_TEXT_LENGTH + 10))).toHaveLength(MAX_AI_SELECTION_TEXT_LENGTH);
    expect(selectionActionQuestion("translate")).toContain("翻译");
    expect(selectionActionQuestion("explain")).toContain("全文");
    expect(selectionActionQuestion("ask", "  这一步为什么成立？ ")).toBe("这一步为什么成立？");
    expect(selectionContext("片段", "ask")).toEqual({ text: "片段", intent: "ask" });
  });

  it("anchors the action rail, underline and answer card inside the visible reading frame", () => {
    const overlay = selectionOverlay([
      { left: 280, top: 200, right: 480, bottom: 224 },
      { left: 280, top: 230, right: 410, bottom: 254 }
    ], { left: 240, top: 80, right: 960, bottom: 720 });

    expect(overlay).toMatchObject({ placement: "right", toolbarLeft: 280, toolbarTop: 263, cardLeft: 496, cardTop: 196, cardWidth: 340 });
    expect(overlay?.underlines).toEqual([
      { left: 280, top: 226, width: 200 },
      { left: 280, top: 256, width: 130 }
    ]);
  });

  it("falls back below the selection when neither side has room for an answer", () => {
    const overlay = selectionOverlay([{ left: 300, top: 300, right: 640, bottom: 324 }], { left: 260, top: 80, right: 700, bottom: 620 });
    expect(overlay?.placement).toBe("below");
    expect(overlay?.cardLeft).toBeGreaterThanOrEqual(276);
    expect(overlay?.cardTop).toBeGreaterThan(overlay?.toolbarTop || 0);
  });
});
