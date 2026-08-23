import {
  MAX_AI_ARTICLE_RAW_TEXT_LENGTH,
  MAX_AI_ARTICLE_TITLE_LENGTH,
  MAX_AI_SOURCE_TITLE_LENGTH,
  normaliseAiArticleText,
  normaliseAiText
} from "../shared/ai-input";
import type { AiArticleContext } from "../shared/types";

/**
 * Builds the one bounded article context used by both the panel and the
 * selected-text helper. `plainText` must come from DOM textContent; the main
 * process repeats its own sanitisation before content can reach a provider.
 */
export function buildAiArticleContext(input: {
  title: string;
  url: string;
  sourceTitle?: string;
  plainText: string;
}): AiArticleContext {
  return {
    title: normaliseAiText(input.title, MAX_AI_ARTICLE_TITLE_LENGTH),
    url: input.url,
    sourceTitle: input.sourceTitle === undefined
      ? undefined
      : normaliseAiText(input.sourceTitle, MAX_AI_SOURCE_TITLE_LENGTH),
    text: normaliseAiArticleText(input.plainText)
  };
}

/**
 * Gather a bounded portion of DOM text before it is normalised for IPC. A
 * reader page may contain very large code samples or generated tables; the AI
 * context only needs a safe excerpt and must not construct their full text.
 */
export function collectAiArticleText(chunks: Iterable<string>): string {
  let remaining = MAX_AI_ARTICLE_RAW_TEXT_LENGTH;
  const collected: string[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const excerpt = chunk.slice(0, remaining);
    collected.push(excerpt);
    remaining -= excerpt.length;
  }
  return collected.join("");
}
