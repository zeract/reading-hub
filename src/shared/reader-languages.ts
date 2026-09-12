import type { ReaderLanguageVariant } from "./types";

/** Product policy, shared by extraction, authorization and the toolbar. */
export function readerLanguageChoices(variants: ReaderLanguageVariant[], currentUrl: string, activeLanguage?: string): ReaderLanguageVariant[] {
  const choices = new Map<string, ReaderLanguageVariant>();
  for (const variant of variants) {
    if (variant.language !== "zh" && variant.language !== "en") continue;
    const current = variant.url === currentUrl && (!variant.inlineLanguage || variant.inlineLanguage === activeLanguage);
    if (!choices.has(variant.language) || current) choices.set(variant.language, variant);
  }
  return [...choices.values()];
}
