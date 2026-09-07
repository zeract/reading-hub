import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJsonWithTimeout } from "../src/main/json-response";

afterEach(() => { vi.useRealTimers(); });

describe("JSON transport ownership and limits", () => {
  it("rejects a successful response larger than the JSON budget", async () => {
    const response = new Response(JSON.stringify({ data: "x".repeat(8_000_000) }));
    await expect(requestJsonWithTimeout(async () => response, "https://example.com/api", {}, undefined, 1000)).rejects.toThrow("超过");
  });

  it("cancels an unread body when the deadline expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel }, { highWaterMark: 0 });
    const pending = expect(requestJsonWithTimeout(async () => new Response(body), "https://example.com/api", {}, undefined, 100))
      .rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("discards headers arriving after caller cancellation", async () => {
    let finish!: (response: Response) => void;
    const headers = new Promise<Response>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const pending = requestJsonWithTimeout(() => headers, "https://example.com/api", {}, controller.signal, 1000);
    controller.abort(new Error("cancel JSON"));
    await expect(pending).rejects.toThrow("cancel JSON");
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts the exact byte budget and correctly decodes split UTF-8", async () => {
    const body = `"${"x".repeat(7_999_998)}"`;
    const exact = await requestJsonWithTimeout<string>(async () => new Response(body), "https://example.com/api", {}, undefined, 1000);
    expect(exact.payload.length).toBe(7_999_998);
    const bytes = new TextEncoder().encode('{"value":"中文😀"}');
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
    const result = await requestJsonWithTimeout(async () => response, "https://example.com/api", {}, undefined, 1000);
    expect(result.payload).toEqual({ value: "中文😀" });
  });

  it("rejects declared oversize before reading and ignores misleading small headers", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const declared = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: { "content-length": "8000001" } });
    await expect(requestJsonWithTimeout(async () => declared, "https://example.com/api", {}, undefined, 1000)).rejects.toThrow("超过 8 MB");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    let pulls = 0;
    const stop = vi.fn();
    const streamed = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++;
      if (pulls <= 2) controller.enqueue(new Uint8Array(4_000_000));
      else if (pulls === 3) controller.enqueue(new Uint8Array(1));
      else controller.enqueue(new Uint8Array(4_000_000));
    }, cancel: stop }, { highWaterMark: 0 }), { headers: { "content-length": "1" } });
    await expect(requestJsonWithTimeout(async () => streamed, "https://example.com/api", {}, undefined, 1000)).rejects.toThrow("超过");
    expect(pulls).toBe(3);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 429, 503])("preserves HTTP %i even if its optional body exceeds the budget", async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status, headers: { "content-length": "8000001" } });
    const result = await requestJsonWithTimeout(async () => response, "https://example.com/api", {}, undefined, 1000);
    expect(result.response.status).toBe(status);
    expect(result.payload).toEqual({});
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves a received 401 when its body stalls until the deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull: () => new Promise<void>(() => undefined), cancel }, { highWaterMark: 0 }), { status: 401 });
    const pending = requestJsonWithTimeout(async () => response, "https://example.com/api", {}, undefined, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).response.status).toBe(401);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets explicit cancellation win over a received 401", async () => {
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 401 });
    const controller = new AbortController();
    const pending = requestJsonWithTimeout(async () => response, "https://example.com/api", {}, controller.signal, 1000);
    const rejected = expect(pending).rejects.toThrow("cancel auth read");
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    controller.abort(new Error("cancel auth read"));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
