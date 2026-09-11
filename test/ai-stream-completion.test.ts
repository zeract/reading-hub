import { afterEach, describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";

type Provider = "openai" | "deepseek";
const article = { title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt" };
const request = (provider: Provider) => ({ provider, question: "Fixture?", article });
const frame = (event: unknown, newline = "\n") => `data: ${JSON.stringify(event)}${newline}${newline}`;
const delta = (provider: Provider, text = "Draft") => provider === "openai"
  ? { type: "response.output_text.delta", delta: text }
  : { choices: [{ delta: { content: text } }] };
const completion = (text: string) => ({ type: "response.completed", response: { status: "completed", error: null,
  output: [{ type: "message", content: [{ type: "output_text", text }] }] } });

function fixture(payload: string, fragmented = false, cancel = vi.fn(), closeAtEnd = false) {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        if (closeAtEnd) controller.close();
        return; // Otherwise hold the transport open after completion.
      }
      const end = fragmented ? offset + 1 : bytes.length;
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel
  }, { highWaterMark: 0 });
  const service = new AiService({
    getConnectorSecret: async () => JSON.stringify({ apiKey: "synthetic", model: "fixture" }),
    setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn()
  }, async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  return { service, body, cancel };
}

afterEach(() => vi.useRealTimers());

describe.each(["openai", "deepseek"] as const)("%s semantic stream completion", (provider) => {
  it.each(["\n", "\r\n", "\r"].flatMap((newline) => [false, true].map((fragmented) => ({ newline, fragmented }))))
    ("settles at the terminal frame and discards its suffix ($newline, fragmented=$fragmented)", async ({ newline, fragmented }) => {
      vi.useFakeTimers();
      const terminal = provider === "openai"
        ? frame({ type: "response.completed", response: { status: "completed" } }, newline)
        : `data: [DONE]${newline}${newline}`;
      const { service, body, cancel } = fixture(frame(delta(provider), newline) + terminal + frame(delta(provider, "Late"), newline) + frame({ type: "error" }, newline), fragmented);
      const update = vi.fn(), settled = vi.fn();
      const pending = service.askStream(request(provider), update).then(settled, settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "Draft" }));
      await pending;
      expect(update).toHaveBeenCalledExactlyOnceWith("Draft");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

  it.each(["pending", "rejected"])("completes even if transport cancellation is %s", async (mode) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => mode === "pending" ? new Promise<void>(() => undefined) : Promise.reject(new Error("private-fixture")));
    const { service, body } = fixture(frame(delta(provider)) + "data: [DONE]\n\n", false, cancel);
    const settled = vi.fn();
    const pending = service.askStream(request(provider), vi.fn()).then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "Draft" }));
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["", "data: [DONE]", "data: [DONE]\n"])("rejects EOF without a complete terminal event (suffix=%j)", async (suffix) => {
    const { service, body, cancel } = fixture(frame(delta(provider)) + suffix, false, vi.fn(), true);
    const update = vi.fn();
    await expect(service.askStream(request(provider), update)).rejects.toThrow("AI 回答未完整生成：连接在收到完成标记前结束，请稍后重试。");
    expect(update).toHaveBeenCalledExactlyOnceWith("Draft");
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });
});

it("does not apply a completion frame without its SSE blank-line boundary", async () => {
  const { service, body, cancel } = fixture(frame(delta("openai")) + frame(completion("Unfinished snapshot")).trimEnd(), false, vi.fn(), true);
  await expect(service.askStream(request("openai"), vi.fn())).rejects.toThrow("AI 回答未完整生成：连接在收到完成标记前结束，请稍后重试。");
  expect(cancel).not.toHaveBeenCalled();
  expect(body.locked).toBe(false);
});

it.each([
  { draft: "", final: "Snapshot only", expected: "Snapshot only" },
  { draft: "Draft", final: "Draft extended", expected: "Draft extended" },
  { draft: "Old draft", final: "Revised answer", expected: "Revised answer" },
  { draft: "a".repeat(40_000), final: "b".repeat(39_999) + "🧪later", expected: "b".repeat(39_999) }
])("uses the bounded OpenAI final snapshot independently of draft deltas ($expected.length units)", async ({ draft, final, expected }) => {
  vi.useFakeTimers();
  const { service } = fixture((draft ? frame(delta("openai", draft)) : "") + frame(completion(final)));
  const update = vi.fn(), settled = vi.fn();
  const pending = service.askStream(request("openai"), update).then(settled, settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expected }));
  await pending;
  expect(update.mock.calls.flat().join("")).toBe(draft);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not turn a failed response into success because the envelope says completed", async () => {
  const { service, cancel } = fixture(frame(delta("openai")) + frame({ type: "response.completed", response: { status: "failed", error: { message: "private-fixture" } } }));
  await expect(service.askStream(request("openai"), vi.fn())).rejects.toThrow("服务在生成回答时返回错误，请稍后重试。");
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("does not substitute an obsolete draft for an explicitly empty final snapshot", async () => {
  vi.useFakeTimers();
  const { service, cancel } = fixture(frame(delta("openai")) + frame({ type: "response.completed", response: { status: "completed", output: [] } }));
  const settled = vi.fn();
  const pending = service.askStream(request("openai"), vi.fn()).then(settled, settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "OpenAI 没有返回可显示的回答，请调整问题后重试。" }));
  await pending;
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("ignores item-level completion and keeps reading until response completion", async () => {
  vi.useFakeTimers();
  const { service } = fixture(frame(delta("openai", "First")) + frame({ type: "response.output_text.done", text: "First" }) + frame(delta("openai", " second")) + frame(completion("First second")));
  const update = vi.fn(), settled = vi.fn();
  const pending = service.askStream(request("openai"), update).then(settled, settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "First second" }));
  await pending;
  expect(update.mock.calls.flat()).toEqual(["First", " second"]);
});
