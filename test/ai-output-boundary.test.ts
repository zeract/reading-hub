import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";
import type { CodexCliRunner } from "../src/main/codex-cli";

const article = { title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt" };
const secrets = () => ({
  getConnectorSecret: async (key?: string) => key === "ai:codex-cli" ? null : JSON.stringify({ apiKey: "synthetic", model: "fixture" }),
  setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn()
});
const question = (provider: "openai" | "deepseek" | "codex-cli") => ({ provider, question: "Fixture?", article });
const longAnswer = "回答".repeat(25_000);
const expected = longAnswer.slice(0, 40_000);

describe("AI service output boundary", () => {
  it.each(["openai", "deepseek"] as const)("preserves the existing %s SSE budget across multiple events", async (provider) => {
    const frame = (text: string) => provider === "openai"
      ? { type: "response.output_text.delta", delta: text }
      : { choices: [{ delta: { content: text } }] };
    const events = [longAnswer.slice(0, 39_990), longAnswer.slice(39_990), "excess"]
      .map((text) => `data: ${JSON.stringify(frame(text))}\n\n`).join("");
    const service = new AiService(secrets(), async () => new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const updates: string[] = [];
    expect((await service.askStream(question(provider), (text) => updates.push(text))).text).toBe(expected);
    expect(updates.join("")).toBe(expected);
  });

  it("accepts the exact output limit and starts a fresh budget for the next question", async () => {
    let text = expected;
    const service = new AiService(secrets(), async () => new Response(JSON.stringify({ output_text: text }), { headers: { "content-type": "application/json" } }));
    const first = vi.fn();
    expect((await service.askStream(question("openai"), first)).text).toBe(expected);
    expect(first).toHaveBeenCalledExactlyOnceWith(expected);
    text = "Next question";
    const second = vi.fn();
    expect((await service.askStream(question("openai"), second)).text).toBe(text);
    expect(second).toHaveBeenCalledExactlyOnceWith(text);
  });

  it.each(["openai", "deepseek"] as const)("bounds %s JSON fallback updates and final answers", async (provider) => {
    const payload = provider === "openai" ? { output_text: longAnswer } : { choices: [{ message: { content: longAnswer } }] };
    const service = new AiService(secrets(), async () => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
    const delta = vi.fn();
    expect((await service.askStream(question(provider), delta)).text).toBe(expected);
    expect(delta).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([false, true])("bounds compatibility runners independently of their transport implementation (stream=%s)", async (stream) => {
    const runner: CodexCliRunner = { status: async () => ({ available: true }), ask: async () => longAnswer };
    if (stream) runner.askStream = async (_instruction, _prompt, _options, onDelta) => {
      onDelta(longAnswer.slice(0, 39_999)); onDelta(longAnswer.slice(39_999)); onDelta("excess");
      return longAnswer;
    };
    const service = new AiService(secrets(), vi.fn(), runner);
    const updates: string[] = [];
    expect((await service.askStream(question("codex-cli"), (text) => updates.push(text))).text).toBe(expected);
    expect(updates.join("")).toBe(expected);
    expect(updates.every(Boolean)).toBe(true);
  });

  it("keeps an authoritative final revision after the incremental budget is exhausted", async () => {
    const runner: CodexCliRunner = { status: async () => ({ available: true }), ask: vi.fn(),
      askStream: async (_instruction, _prompt, _options, onDelta) => {
        onDelta(longAnswer);
        return "Revised final answer";
      }
    };
    const delta = vi.fn();
    const service = new AiService(secrets(), vi.fn(), runner);
    expect((await service.askStream(question("codex-cli"), delta)).text).toBe("Revised final answer");
    expect(delta).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([false, true])("ignores delayed runner callbacks after settlement (failure=%s)", async (failure) => {
    let late!: (text: string) => void;
    const runner: CodexCliRunner = { status: async () => ({ available: true }), ask: vi.fn(),
      askStream: async (_instruction, _prompt, _options, onDelta) => {
        late = onDelta;
        onDelta("Current");
        if (failure) throw new Error("Synthetic failure");
        return "Current";
      }
    };
    const delta = vi.fn();
    const service = new AiService(secrets(), vi.fn(), runner);
    const pending = service.askStream(question("codex-cli"), delta);
    if (failure) await expect(pending).rejects.toThrow("未能完成回答");
    else expect((await pending).text).toBe("Current");
    late("Must not arrive");
    expect(delta).toHaveBeenCalledExactlyOnceWith("Current");
  });

  it("does not publish an uncancellable legacy runner's late result after cancellation", async () => {
    let finish!: (text: string) => void;
    const started = vi.fn();
    const runner: CodexCliRunner = { status: async () => ({ available: true }), ask: () => {
      started(); return new Promise<string>((resolve) => { finish = resolve; });
    } };
    const controller = new AbortController(), delta = vi.fn();
    const service = new AiService(secrets(), vi.fn(), runner);
    const pending = service.askStream(question("codex-cli"), delta, controller.signal);
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    controller.abort(new Error("Fixture cancelled"));
    const rejected = expect(pending).rejects.toThrow("Fixture cancelled");
    finish("Must not arrive");
    await rejected;
    expect(delta).not.toHaveBeenCalled();
  });
});
