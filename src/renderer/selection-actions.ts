import type { AiSelectionContext, AiSelectionIntent } from "../shared/types";

export const MAX_SELECTED_ARTICLE_TEXT = 2_000;

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
