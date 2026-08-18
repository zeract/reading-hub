import type { AiSelectionContext, AiSelectionIntent } from "../shared/types";

export const MAX_SELECTED_ARTICLE_TEXT = 2_000;

export type SelectionRect = { left: number; top: number; right: number; bottom: number };
export type SelectionUnderline = { left: number; top: number; width: number };
export type SelectionOverlay = {
  toolbarLeft: number;
  toolbarTop: number;
  cardLeft: number;
  cardTop: number;
  cardWidth: number;
  cardMaxHeight: number;
  placement: "right" | "left" | "below";
  underlines: SelectionUnderline[];
};

const EDGE_GUTTER = 16;
const TOOLBAR_WIDTH = 220;
const TOOLBAR_HEIGHT = 38;
const CARD_WIDTH = 340;
const CARD_MIN_VISIBLE_HEIGHT = 184;

/**
 * Keep every selection affordance in the reader's visible frame. The browser's
 * native selection vanishes once an action is pressed, so the returned
 * underlines preserve a precise, non-invasive anchor for the in-context card.
 */
export function selectionOverlay(rects: SelectionRect[], frame: SelectionRect): SelectionOverlay | undefined {
  const visible = rects.filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  if (!visible.length || frame.right - frame.left < EDGE_GUTTER * 2) return undefined;
  const bounds = visible.reduce((current, rect) => ({
    left: Math.min(current.left, rect.left),
    top: Math.min(current.top, rect.top),
    right: Math.max(current.right, rect.right),
    bottom: Math.max(current.bottom, rect.bottom)
  }), { ...visible[0] });
  const availableWidth = Math.max(220, frame.right - frame.left - EDGE_GUTTER * 2);
  const cardWidth = Math.min(CARD_WIDTH, availableWidth);
  const toolbarLeft = clamp(bounds.left, frame.left + EDGE_GUTTER, frame.right - TOOLBAR_WIDTH - EDGE_GUTTER);
  const toolbarTop = clamp(bounds.bottom + 9, frame.top + EDGE_GUTTER, frame.bottom - TOOLBAR_HEIGHT - EDGE_GUTTER);
  const canFitRight = bounds.right + EDGE_GUTTER + cardWidth <= frame.right - EDGE_GUTTER;
  const canFitLeft = bounds.left - EDGE_GUTTER - cardWidth >= frame.left + EDGE_GUTTER;
  const placement = canFitRight ? "right" : canFitLeft ? "left" : "below";
  const proposedLeft = placement === "right"
    ? bounds.right + EDGE_GUTTER
    : placement === "left"
      ? bounds.left - EDGE_GUTTER - cardWidth
      : bounds.left + (bounds.right - bounds.left) / 2 - cardWidth / 2;
  const proposedTop = placement === "below" ? toolbarTop + TOOLBAR_HEIGHT + 8 : bounds.top - 4;
  const cardLeft = clamp(proposedLeft, frame.left + EDGE_GUTTER, frame.right - cardWidth - EDGE_GUTTER);
  const cardTop = clamp(proposedTop, frame.top + EDGE_GUTTER, frame.bottom - CARD_MIN_VISIBLE_HEIGHT - EDGE_GUTTER);
  return {
    toolbarLeft,
    toolbarTop,
    cardLeft,
    cardTop,
    cardWidth,
    cardMaxHeight: Math.max(CARD_MIN_VISIBLE_HEIGHT, Math.min(420, frame.bottom - cardTop - EDGE_GUTTER)),
    placement,
    underlines: visible.slice(0, 18).map((rect) => ({ left: rect.left, top: rect.bottom + 2, width: rect.right - rect.left }))
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function normaliseSelectedArticleText(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, MAX_SELECTED_ARTICLE_TEXT);
}

export function selectionActionQuestion(intent: AiSelectionIntent, customQuestion?: string): string | undefined {
  if (intent === "translate") return "请把所选文字翻译成自然、准确的中文，并结合全文语境保留术语、公式与专有名词。";
  if (intent === "explain") return "请解释所选文字的含义、关键概念，以及它在全文论述中的作用。";
  const question = customQuestion?.replace(/\s+/g, " ").trim();
  return question || undefined;
}

export function selectedTextLabel(intent: AiSelectionIntent): string {
  return { translate: "翻译所选文字", explain: "解释所选文字", ask: "询问所选文字" }[intent];
}

export function selectionContext(text: string, intent: AiSelectionIntent): AiSelectionContext {
  return { text, intent };
}
