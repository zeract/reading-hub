import { afterEach, describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";

const question = { provider: "openai" as const, question: "Explain the fixture", article: { title: "Fixture", url: "https://example.com/post", text: "Synthetic source text." } };
const encoder = new TextEncoder();

function service(fetcher: (...args: any[]) => Promise<Response>) {
  return new AiService({
    getConnectorSecret: async () => JSON.stringify({ apiKey: "fixture-key", model: "fixture-model" }),
    setConnectorSecret: async () => "ai:openai", clearConnectorSecret: async () => undefined
  }, fetcher);
}

afterEach(() => vi.useRealTimers());

describe("AI response transport lifetime", () => {
  it("cancels the unread body when the provider sends an error event", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"type":"error","message":"fixture-private-details"}\n\n')); }, cancel
    });
    const ai = service(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(ai.askStream(question, () => undefined)).rejects.toThrow("服务在生成回答时返回错误");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("discards an unsuccessful HTTP response without reading its diagnostics", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const ai = service(async () => new Response(body, { status: 401 }));
    await expect(ai.askStream(question, () => undefined)).rejects.toThrow("拒绝了 API Key");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "openai" as const, timeout: 45_000 },
    { provider: "deepseek" as const, timeout: 180_000 }
  ])("$provider finishes a stalled body timeout even when transport cancellation never settles", async ({ provider, timeout }) => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    const ai = service(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    let settled = false;
    const outcome = ai.askStream({ ...question, provider }, () => undefined).catch((error) => error).then((value) => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(timeout - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await outcome).message).toContain("请求超时");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      try { stream.close(); } catch { /* Already cancelled. */ }
      await outcome;
    }
  });

  it("bounds raw SSE data even if it never contains a complete event", async () => {
    const ai = service(async () => new Response(new Uint8Array(8_000_001), { headers: { "content-type": "text/event-stream" } }));
    await expect(ai.askStream(question, () => undefined)).rejects.toThrow("返回的数据过大");
  });

  it.each(["text/event-stream", "application/json"])("cancels an active %s read and allows a later retry", async (contentType) => {
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => { reading = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); return new Promise<void>(() => undefined); }, cancel }, { highWaterMark: 0 });
    const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": contentType } }));
    const ai = service(fetcher);
    const controller = new AbortController();
    const pending = ai.askStream(question, () => undefined, controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancel response");
    await entered;
    controller.abort(new Error("cancel response"));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ output_text: "Retry answer" }), { headers: { "content-type": "application/json" } }));
    await expect(ai.askStream(question, () => undefined)).resolves.toMatchObject({ text: "Retry answer" });
  });

  it("discards a response that arrives after cancellation wins the fetch wait", async () => {
    let fetched!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const ai = service(async () => { started(); return new Promise<Response>((resolve) => { fetched = resolve; }); });
    const controller = new AbortController();
    const pending = ai.askStream(question, () => undefined, controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancel pending fetch");
    await entered;
    controller.abort(new Error("cancel pending fetch"));
    await rejected;
    const cancel = vi.fn();
    fetched(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("discards a response cancelled between receiving headers and starting its reader", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
    Object.defineProperty(response, "ok", { get() { controller.abort(new Error("cancel before reading")); return true; } });
    const ai = service(async () => response);
    await expect(ai.askStream(question, () => undefined, controller.signal)).rejects.toThrow("cancel before reading");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("times out before headers without waiting for a transport that ignores abort", async () => {
    vi.useFakeTimers();
    const ai = service(async () => new Promise<Response>(() => undefined));
    const rejected = expect(ai.askStream(question, () => undefined)).rejects.toThrow("请求超时");
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds JSON fallback bodies and hides invalid JSON details", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(8_000_001), { headers: { "content-type": "application/json" } }));
    const ai = service(fetcher);
    await expect(ai.askStream(question, () => undefined)).rejects.toThrow("返回的数据过大");
    fetcher.mockResolvedValueOnce(new Response('{"fixture-private-details": broken', { headers: { "content-type": "application/json" } }));
    await expect(ai.askStream(question, () => undefined)).rejects.toThrow("AI 服务返回的数据格式无效，请稍后重试。");
  });

  it("accepts the exact wire limit and preserves UTF-8 deltas split across chunks", async () => {
    const frame = encoder.encode('data: {"type":"response.output_text.delta","delta":"中文回答"}\r\n\r\n');
    const terminal = encoder.encode("\n\ndata: [DONE]\n\n");
    const tail = new Uint8Array(8_000_000 - frame.byteLength - terminal.byteLength).fill(32);
    tail[0] = 58; // A bounded SSE comment before completion, not an unread suffix.
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of frame) controller.enqueue(Uint8Array.of(byte));
      controller.enqueue(tail);
      controller.enqueue(terminal);
      controller.close();
    } });
    const delta = vi.fn();
    const ai = service(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(ai.askStream(question, delta)).resolves.toMatchObject({ text: "中文回答" });
    expect(delta).toHaveBeenCalledWith("中文回答");
    expect(body.locked).toBe(false);
  });

  it("keeps the same safe failure for a broken stream without exposing transport details", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("fixture-private-transport-details")); } });
    const ai = service(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(ai.askStream(question, () => undefined)).rejects.toThrow("读取 AI 回答失败，请稍后重试。");
    expect(body.locked).toBe(false);
  });
});


it("allows DeepSeek reasoning beyond 45 seconds without displaying reasoning or retrying", async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    stream = controller;
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n'));
  }, cancel });
  const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const ai = service(fetcher);
  const delta = vi.fn(), settled = vi.fn();
  const pending = ai.askStream({ ...question, provider: "deepseek" }, delta).then(settled, settled);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).not.toHaveBeenCalled();
  expect(delta).not.toHaveBeenCalled();
  const answer = "这是完整回答。".repeat(500);
  stream.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  await pending;
  expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: answer }));
  expect(delta).toHaveBeenCalledExactlyOnceWith(answer);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
