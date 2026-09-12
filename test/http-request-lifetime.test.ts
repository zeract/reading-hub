import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { PublicHttpClient } from "../src/main/http";

const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
const read = (http: PublicHttpClient, image: boolean, signal?: AbortSignal) => image
  ? http.getImageDataUrl("https://example.com/image.png", "https://example.com/post", { signal })
  : http.getText("https://example.com/post", undefined, { signal });

beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("public response header lifetime", () => {
  it.each([false, true])("ends a stalled header timeout (image=%s)", async (image) => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    network.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    let settled = false;
    let failure: unknown;
    const pending = read(client(), image).then(() => { settled = true; }, (error) => { settled = true; failure = error; });
    await vi.advanceTimersByTimeAsync(image ? 40_500 : 20_000);
    try { expect(settled).toBe(true); expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toMatch(/超时/); }
    finally { finish(new Response("", { headers: { "content-type": "image/png" } })); await pending; }
  });

  it.each([false, true])("ends caller cancellation while headers remain pending (image=%s)", async (image) => {
    let finish!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    network.fetch.mockImplementationOnce(() => { entered(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    const controller = new AbortController();
    let settled = false;
    const pending = read(client(), image, controller.signal).then(() => { settled = true; }, () => { settled = true; });
    await started;
    controller.abort(new Error("fixture cancel"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try { expect(settled).toBe(true); }
    finally { finish(new Response("", { headers: { "content-type": "image/png" } })); await pending; }
  });

  it.each([false, true])("discards late headers without following redirects or caching data, then retries (image=%s)", async (image) => {
    let finish!: (response: Response) => void;
    network.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const http = client();
    const pending = read(http, image, controller.signal);
    const rejected = expect(pending).rejects.toThrow("leave reader");
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error("leave reader"));
    await rejected;
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
      status: 302, headers: { location: "https://redirect.example.com/post", "content-type": "image/png" }
    }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(network.fetch).toHaveBeenCalledTimes(1);
    network.fetch.mockResolvedValueOnce(new Response("fresh", { headers: { "content-type": "image/png" } }));
    const result = await read(http, image);
    if (image) expect(result).toBe(`data:image/png;base64,${Buffer.from("fresh").toString("base64")}`);
    else expect(result).toMatchObject({ text: "fresh" });
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not turn cancelled conditional requests into a successful 304", async () => {
    const controller = new AbortController();
    network.fetch.mockImplementationOnce(async () => {
      controller.abort(new Error("cancel conditional read"));
      return new Response(null, { status: 304 });
    });
    await expect(client().getText("https://example.com/post", { url: "https://example.com/post", etag: "fixture-etag" }, { signal: controller.signal })).rejects.toThrow("cancel conditional read");
  });
});
