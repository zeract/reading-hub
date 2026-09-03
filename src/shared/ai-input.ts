/**
 * Bounded, plain-text limits for the renderer → main-process AI IPC contract.
 * Keep these values shared: the renderer prepares a small excerpt for every
 * request, while the main process enforces the exact same boundary before any
 * provider or local CLI receives content.
 */
export const AI_STREAM_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
export const MAX_AI_QUESTION_LENGTH = 3_000;
export const MAX_AI_ARTICLE_TITLE_LENGTH = 500;
export const MAX_AI_ARTICLE_URL_LENGTH = 2_000;
export const MAX_AI_ARTICLE_TEXT_LENGTH = 18_000;
// Keep a small, bounded amount of raw DOM text before whitespace compaction.
// This avoids building a complete textContent string for unusually long pages
// while still leaving enough room for normal prose to reach the final limit.
export const MAX_AI_ARTICLE_RAW_TEXT_LENGTH = MAX_AI_ARTICLE_TEXT_LENGTH * 8;
export const MAX_AI_SOURCE_TITLE_LENGTH = 200;
export const MAX_AI_SELECTION_TEXT_LENGTH = 2_000;

/**
 * Normalise a renderer-produced article excerpt before crossing IPC. The main
 * process applies this again defensively, so an old renderer cannot bypass
 * the provider-facing limit during a development hot reload.
 */
export function normaliseAiArticleText(value: string): string {
  return normaliseAiText(value, MAX_AI_ARTICLE_TEXT_LENGTH);
}

export function normaliseAiText(value: string, maximum: number): string {
  let result = "";
  let pendingSpace = false;
  for (const character of value) {
    if (/\s/.test(character)) {
      pendingSpace = result.length > 0;
      continue;
    }
    const prefix = pendingSpace ? " " : "";
    if (result.length + prefix.length + character.length > maximum) break;
    result += prefix + character;
    pendingSpace = false;
  }
  return result;
}
