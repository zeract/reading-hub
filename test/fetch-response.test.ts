import { describe, expect, it, vi } from "vitest";
import { fetchResponse } from "../src/main/fetch-response";

describe("response ownership transfer", () => {
  it("releases a response if cancellation wins between receiving it and completing the wait", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
    const headers = Promise.resolve(response);
    const controller = new AbortController();
    const pending = fetchResponse(() => headers, "https://example.com/", { signal: controller.signal });
    // Runs after fetchResponse's receiving callback, before its wait settles.
    void headers.then(() => controller.abort(new Error("cancel handoff")));
    await expect(pending).rejects.toThrow("cancel handoff");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not start a pre-cancelled fetch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const fetcher = vi.fn();
    await expect(fetchResponse(fetcher, "https://example.com/", { signal: controller.signal })).rejects.toThrow("already cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disposes a late body without waiting for cancellation to settle", async () => {
    let finish!: (response: Response) => void;
    const headers = new Promise<Response>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const pending = fetchResponse(() => headers, "https://example.com/", { signal: controller.signal });
    controller.abort(new Error("stop waiting"));
    await expect(pending).rejects.toThrow("stop waiting");
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    finish(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("observes a transport rejection after the caller has cancelled", async () => {
    let fail!: (error: Error) => void;
    const headers = new Promise<Response>((_resolve, reject) => { fail = reject; });
    const controller = new AbortController();
    const pending = fetchResponse(() => headers, "https://example.com/", { signal: controller.signal });
    controller.abort(new Error("stop waiting"));
    await expect(pending).rejects.toThrow("stop waiting");
    fail(new Error("fixture late transport failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("transfers an unread successful body to the caller and releases listeners", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("fixture")); controller.close(); }, cancel }));
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = await fetchResponse(async () => response, "https://example.com/", { signal: controller.signal });
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(await result.text()).toBe("fixture");
    for (const [event, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(event, listener);
  });

  it("preserves synchronous transport failure for the caller to classify", async () => {
    const error = new Error("fixture synchronous failure");
    await expect(fetchResponse(() => { throw error; }, "https://example.com/", {})).rejects.toBe(error);
  });
});
