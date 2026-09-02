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
/** Full-article translation may retain safe Markdown line structure, but not more content. */
export const MAX_AI_ARTICLE_MARKDOWN_LENGTH = MAX_AI_ARTICLE_TEXT_LENGTH;
// Keep a small, bounded amount of raw DOM text before whitespace compaction.
// This avoids building a complete textContent string for unusually long pages
// while still leaving enough room for normal prose to reach the final limit.
export const MAX_AI_ARTICLE_RAW_TEXT_LENGTH = MAX_AI_ARTICLE_TEXT_LENGTH * 8;
export const MAX_AI_SOURCE_TITLE_LENGTH = 200;
export const MAX_AI_SELECTION_TEXT_LENGTH = 2_000;
/** Keep immersive batches small enough for low-latency local-model turns. */
export const MAX_AI_IMMERSIVE_TRANSLATION_SEGMENTS = 4;
export const MAX_AI_IMMERSIVE_TRANSLATION_SEGMENT_LENGTH = 1_600;
export const MAX_AI_IMMERSIVE_TRANSLATION_BATCH_LENGTH = 4_800;
export const AI_TRANSLATION_SEGMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Normalise a renderer-produced article excerpt before crossing IPC. The main
 * process applies this again defensively, so an old renderer cannot bypass
 * the provider-facing limit during a development hot reload.
 */
export function normaliseAiArticleText(value: string): string {
  return normaliseAiText(value, MAX_AI_ARTICLE_TEXT_LENGTH);
}

/**
 * Keep only inert, renderer-produced Markdown structure for an explicit
 * full-article translation. This intentionally does not parse or render
 * Markdown: the main process still treats it as untrusted reference text.
 */
export function normaliseAiArticleMarkdown(value: string): string {
  const normalised = value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // IPC validates JavaScript string length as well, so retain the same unit
  // here while avoiding a split surrogate pair at the bounded tail.
  let bounded = "";
  for (const character of normalised) {
    if (bounded.length + character.length > MAX_AI_ARTICLE_MARKDOWN_LENGTH) break;
    bounded += character;
  }
  return bounded;
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
