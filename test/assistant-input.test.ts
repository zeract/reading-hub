import { describe, expect, it } from "vitest";
import { shouldSubmitAssistantQuestion } from "../src/renderer/assistant-input";

describe("AI learning question input", () => {
  it("submits with Enter, but keeps Shift+Enter and IME composition intact", () => {
    expect(shouldSubmitAssistantQuestion("Enter", false, false)).toBe(true);
    expect(shouldSubmitAssistantQuestion("Enter", true, false)).toBe(false);
    expect(shouldSubmitAssistantQuestion("Enter", false, true)).toBe(false);
    expect(shouldSubmitAssistantQuestion("a", false, false)).toBe(false);
  });
});
