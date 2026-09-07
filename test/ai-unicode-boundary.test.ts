import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";
import type { CodexCliRunner } from "../src/main/codex-cli";

const article = { title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt" };
const secrets = () => ({
  getConnectorSecret: async (key?: string) => key === "ai:codex-cli" ? null : JSON.stringify({ apiKey: "synthetic", model: "fixture" }),
  setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn()
});
const cases = [
  { name: "whole emoji crossing the limit", chunks: ["a".repeat(39_999), "🧪", "later"], expected: "a".repeat(39_999) },
  { name: "split emoji crossing the limit", chunks: ["a".repeat(39_999), "\ud83e", "\uddea", "later"], expected: "a".repeat(39_999) },
  { name: "split emoji fitting exactly", chunks: ["a".repeat(39_998), "\ud83e", "\uddea", "later"], expected: "a".repeat(39_998) + "🧪" },
  { name: "supplementary Chinese crossing the limit", chunks: ["a".repeat(39_999), "𠮷", "later"], expected: "a".repeat(39_999) }
];

describe.each(["openai", "deepseek"] as const)("%s Unicode output boundary", (provider) => {
  it.each(cases)("preserves the answer prefix for SSE: $name", async ({ chunks, expected }) => {
    const events = chunks.map((text) => provider === "openai"
      ? { type: "response.output_text.delta", delta: text }
      : { choices: [{ delta: { content: text } }] });
    const response = new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const service = new AiService(secrets(), async () => response);
    const updates: string[] = [];
    const answer = await service.askStream({ provider, question: "Fixture?", article }, (text) => updates.push(text));
    expect(answer.text).toBe(expected);
    expect(updates.join("")).toBe(expected);
    expect(updates.every(Boolean)).toBe(true);
  });

  it("clips JSON snapshots without retaining half a surrogate pair", async () => {
    const expected = "a".repeat(39_999), text = expected + "🧪later";
    const payload = provider === "openai" ? { output_text: text } : { choices: [{ message: { content: text } }] };
    const service = new AiService(secrets(), async () => Response.json(payload));
    const delta = vi.fn();
    expect((await service.askStream({ provider, question: "Fixture?", article }, delta)).text).toBe(expected);
    expect(delta).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

describe.each([false, true])("compatibility runner Unicode boundary (stream=%s)", (stream) => {
  it.each(cases)("preserves the answer prefix: $name", async ({ chunks, expected }) => {
    const runner: CodexCliRunner = { status: async () => ({ available: true }), ask: async () => chunks.join("") };
    if (stream) runner.askStream = async (_instruction, _prompt, _options, onDelta) => {
      chunks.forEach(onDelta);
      return chunks.join("");
    };
    const updates: string[] = [];
    const answer = await new AiService(secrets(), vi.fn(), runner).askStream({ provider: "codex-cli", question: "Fixture?", article }, (text) => updates.push(text));
    expect(answer.text).toBe(expected);
    expect(updates.join("")).toBe(expected);
    expect(updates.every(Boolean)).toBe(true);
  });
});
