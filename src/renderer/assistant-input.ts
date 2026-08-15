/**
 * Keep textarea behaviour familiar: Enter sends, while Shift+Enter retains a
 * newline. IME composition must never submit half-composed Chinese text.
 */
export function shouldSubmitAssistantQuestion(key: string, shiftKey: boolean, isComposing: boolean): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}
