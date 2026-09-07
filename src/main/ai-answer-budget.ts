import { MAX_AI_ANSWER_LENGTH } from "../shared/types";

/** Keep the existing UTF-16 budget without cutting a surrogate pair in half. */
export function truncateAiAnswer(text: string, limit = MAX_AI_ANSWER_LENGTH): string {
  let end = Math.min(text.length, limit);
  const last = text.charCodeAt(end - 1);
  // At the budget boundary, a high surrogate cannot fit its partner, even
  // when that partner will arrive in a later delta.
  if (end === limit && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Count the original prefix, including a code unit omitted at the boundary. */
export class AiAnswerBudget {
  private remaining = MAX_AI_ANSWER_LENGTH;

  take(text: string): string {
    const accepted = truncateAiAnswer(text, this.remaining);
    this.remaining = Math.max(0, this.remaining - text.length);
    return accepted;
  }

  /** Final snapshots can revise a draft and establish a new bounded prefix. */
  reset(snapshot: string): string {
    this.remaining = Math.max(0, MAX_AI_ANSWER_LENGTH - snapshot.length);
    return truncateAiAnswer(snapshot);
  }
}
