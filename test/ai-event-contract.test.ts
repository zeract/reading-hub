import { afterEach, describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";

type Provider = "openai" | "deepseek";
const article = { title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt" };
const invalidMessage = "AI 服务返回的数据格式无效，请稍后重试。";
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const delta = (provider: Provider, text: unknown) => provider === "openai"
  ? { type: "response.output_text.delta", delta: text } : { choices: [{ delta: { content: text } }] };
const completion = (response: unknown) => ({ type: "response.completed", response });
function fixture(payload: string, sse = true) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(payload)); if (!sse) controller.close(); }, cancel
  });
  const service = new AiService({
    getConnectorSecret: async () => JSON.stringify({ apiKey: "synthetic-key", model: "fixture" }),
    setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn()
  }, async () => new Response(body, { headers: { "content-type": sse ? "text/event-stream" : "application/json" } }));
  return { service, body, cancel };
}
afterEach(() => vi.useRealTimers());

describe.each(["openai", "deepseek"] as const)("%s event contract", (provider) => {
  it.each(["{private-fixture", "null", "[]", "42", '"private-fixture"'])("rejects corrupt event data %s before completion", async (data) => {
    vi.useFakeTimers();
    const { service, body, cancel } = fixture(frame(delta(provider, "Draft")) + `data: ${data}\n\n` + frame(delta(provider, "Late")) + "data: [DONE]\n\n");
    const update = vi.fn();
    await expect(service.askStream({ provider, question: "Fixture?", article }, update)).rejects.toThrow(invalidMessage);
    expect(update).toHaveBeenCalledExactlyOnceWith("Draft");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([42, {}, []])("rejects a malformed text delta %j", async (value) => {
    const { service, cancel } = fixture(frame(delta(provider, "Draft")) + frame(delta(provider, value)) + "data: [DONE]\n\n");
    const update = vi.fn();
    await expect(service.askStream({ provider, question: "Fixture?", article }, update)).rejects.toThrow(invalidMessage);
    expect(update).toHaveBeenCalledExactlyOnceWith("Draft");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves heartbeats, unknown metadata and valid empty content", async () => {
    const auxiliary = provider === "openai" ? [{ type: "response.future_event", payload: [] }, delta(provider, "")]
      : [{ choices: [], usage: { total_tokens: 1 } }, { choices: [{ delta: { role: "assistant", content: null } }] }, { choices: [{ delta: { reasoning_content: "private-fixture" } }] }, { choices: [{ delta: {} }] }];
    const { service } = fixture(": keep-alive\n\n" + auxiliary.map(frame).join("") + frame(delta(provider, "Answer")) + "data: [DONE]\n\n");
    const update = vi.fn();
    await expect(service.askStream({ provider, question: "Fixture?", article }, update)).resolves.toMatchObject({ text: "Answer" });
    expect(update).toHaveBeenCalledExactlyOnceWith("Answer");
  });
});

it.each([undefined, null])("rejects an OpenAI text event with missing or null delta (%j)", async (value) => {
  const { service } = fixture(frame(delta("openai", "Draft")) + frame(delta("openai", value)) + "data: [DONE]\n\n");
  await expect(service.askStream({ provider: "openai", question: "Fixture?", article }, vi.fn())).rejects.toThrow(invalidMessage);
});

it.each([{ choices: {} }, { choices: [null] }, { choices: [{ delta: [] }] }, { choices: [{ delta: null }] }])("rejects a malformed DeepSeek envelope %j", async (event) => {
  const { service } = fixture(frame(delta("deepseek", "Draft")) + frame(event) + "data: [DONE]\n\n");
  await expect(service.askStream({ provider: "deepseek", question: "Fixture?", article }, vi.fn())).rejects.toThrow(invalidMessage);
});

it.each([{ choices: {} }, { choices: [null] }, { choices: [{ message: [] }] }, { choices: [{ message: { content: 42 } }] }])("rejects malformed DeepSeek JSON output %j", async (body) => {
  const { service } = fixture(JSON.stringify(body), false);
  const update = vi.fn();
  await expect(service.askStream({ provider: "deepseek", question: "Fixture?", article }, update)).rejects.toThrow(invalidMessage);
  expect(update).not.toHaveBeenCalled();
});

const invalidSnapshots = [null, [], { output: {} }, { output_text: 42 },
  { output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }, { type: "output_text", text: 42 }] }] }];
describe.each(invalidSnapshots.map((snapshot) => ({ snapshot })))("OpenAI invalid snapshot $snapshot", ({ snapshot }) => {
  it.each([true, false])("rejects invalid output in SSE=%s", async (sse) => {
    const { service } = fixture(sse ? frame(delta("openai", "Draft")) + frame(completion(snapshot)) : JSON.stringify(snapshot), sse);
    const update = vi.fn();
    await expect(service.askStream({ provider: "openai", question: "Fixture?", article }, update)).rejects.toThrow(invalidMessage);
    expect(update.mock.calls.flat()).toEqual(sse ? ["Draft"] : []);
  });
});
