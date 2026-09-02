import type { AiTranslationTarget } from "../shared/types";

/** Default to Chinese for every non-Chinese article, including an unknown tag. */
export function bilingualTranslationTarget(language?: string): AiTranslationTarget {
  const primary = language?.trim().toLowerCase().split("-")[0];
  return primary === "zh" ? "en" : "zh";
}

export function bilingualTranslationLabel(target: AiTranslationTarget): string {
  return target === "zh" ? "中文译文" : "English translation";
}

/** The main process ignores this display string for translation prompts. */
export function bilingualTranslationQuestion(target: AiTranslationTarget): string {
  return target === "zh" ? "将当前文章翻译为中文。" : "Translate the current article into English.";
}
