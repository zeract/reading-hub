import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicHttpClient } from "../src/main/http";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("../src/main/network", () => ({ chromiumFetch: fetcher }));
const target = "https://example.com/image.png";
const referrer = "https://example.com/article";
const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);

describe("bounded image responses", () => {
  afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

  it("stops at the first oversized chunk instead of buffering the complete image", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) controller.enqueue(new Uint8Array(4_000_000));
        else if (pulls === 3) controller.enqueue(new Uint8Array(1));
        else if (pulls === 4) controller.enqueue(new Uint8Array(4_000_000));
        else controller.close();
      }, cancel
    }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png", "content-length": "1" } }));
    await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow("8 MB");
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("cancels a declared oversized body before reading it", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png", "content-length": "8000001" } }));
    await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow("8 MB");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("encodes successful bytes and reuses only the matching article/image cache entry", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    fetcher.mockImplementation(async () => new Response(bytes, { headers: { "content-type": "image/png" } }));
    const http = client();
    const result = await http.getImageDataUrl(target, referrer);
    expect(result).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(await http.getImageDataUrl(target, referrer)).toBe(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await http.getImageDataUrl(target, "https://example.com/another-article");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts the exact byte limit", async () => {
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(8_000_000), { headers: { "content-type": "image/png" } }));
    const result = await client().getImageDataUrl(target, referrer);
    expect(Buffer.from(result.split(",")[1], "base64").byteLength).toBe(8_000_000);
  });

  it("times out a stalled body even if the transport does not settle cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png" } }));
    const rejected = expect(client().getImageDataUrl(target, referrer)).rejects.toThrow("图片请求超时");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a body read at the caller's request and allows a later retry", async () => {
    const cancel = vi.fn();
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png" } }));
    const http = client();
    const controller = new AbortController();
    const pending = http.getImageDataUrl(target, referrer, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancel image");
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    controller.abort(new Error("cancel image"));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response("fixture", { headers: { "content-type": "image/png" } }));
    await expect(http.getImageDataUrl(target, referrer)).resolves.toContain("data:image/png;base64,");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["redirect", "unsupported", "http-error"])("discards an unread %s body", async (kind) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = kind === "redirect" ? new Response(body, { status: 302, headers: { location: "https://127.0.0.1/private" } })
      : kind === "http-error" ? new Response(body, { status: 403 })
      : new Response(body, { headers: { "content-type": "image/svg+xml" } });
    fetcher.mockResolvedValueOnce(response);
    await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
