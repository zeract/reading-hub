import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { PublicHttpClient } from "../src/main/http";
const target = "https://example.com/image.png";
const referrer = "https://example.com/article";
const response = () => new Response("fixture", { headers: { "content-type": "image/png" } });
const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("shared reader image requests", () => {
  it("downloads and decodes one response for the same article and image", async () => {
    network.fetch.mockImplementation(async () => response());
    const http = client();
    const results = await Promise.all([http.getImageDataUrl(target, referrer), http.getImageDataUrl(target, referrer)]);
    expect(results[0]).toBe(results[1]);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared download alive when one reader cancels", async () => {
    let finish!: (response: Response) => void;
    network.fetch.mockImplementation(() => new Promise<Response>((resolve) => {
      finish = resolve;
    }));
    const http = client();
    const controller = new AbortController();
    const first = expect(http.getImageDataUrl(target, referrer, { signal: controller.signal })).rejects.toThrow("leave first");
    const second = http.getImageDataUrl(target, referrer);
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalled());
    controller.abort(new Error("leave first"));
    await first;
    const signal = network.fetch.mock.calls[0][1].signal;
    finish(response());
    await second;
    expect(signal.aborted).toBe(false);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not merge referrers or unrelated image addresses", async () => {
    network.fetch.mockImplementation(async () => response());
    const http = client();
    await Promise.all([
      http.getImageDataUrl(target, referrer),
      http.getImageDataUrl(target, referrer + "-other"),
      http.getImageDataUrl(target + "?variant=2", referrer)
    ]);
    expect(network.fetch).toHaveBeenCalledTimes(3);
    expect(network.fetch.mock.calls.map((call) => call[1].referrer)).toEqual([referrer, referrer + "-other", referrer]);
  });

  it("cancels a stalled body only after the last waiter leaves and never caches it", async () => {
    const cancel = vi.fn();
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    network.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: { "content-type": "image/png" } }));
    const http = client();
    const one = new AbortController(), two = new AbortController();
    const first = expect(http.getImageDataUrl(target, referrer, { signal: one.signal })).rejects.toThrow("first left");
    const second = expect(http.getImageDataUrl(target, referrer, { signal: two.signal })).rejects.toThrow("second left");
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    one.abort(new Error("first left")); await first;
    expect(cancel).not.toHaveBeenCalled();
    two.abort(new Error("second left")); await second;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    network.fetch.mockResolvedValueOnce(response());
    await expect(http.getImageDataUrl(target, referrer)).resolves.toContain("data:image/png;base64,");
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let cancelled late headers remove a replacement shared download", async () => {
    const pending: { finish: (response: Response) => void; signal: AbortSignal }[] = [];
    network.fetch.mockImplementation((_url, init) => new Promise<Response>((finish) => { pending.push({ finish, signal: init.signal }); }));
    const http = client();
    const controller = new AbortController();
    const first = expect(http.getImageDataUrl(target, referrer, { signal: controller.signal })).rejects.toThrow("abandon old");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    controller.abort(new Error("abandon old"));
    expect(pending[0].signal.aborted).toBe(true);
    const second = http.getImageDataUrl(target, referrer);
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const cancel = vi.fn();
    pending[0].finish(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status: 302, headers: { location: "https://other.example/image.png" } }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    const third = http.getImageDataUrl(target, referrer);
    pending[1].finish(response());
    const [a, b] = await Promise.all([second, third]);
    expect(a).toBe(b);
    expect(await http.getImageDataUrl(target, referrer)).toBe(a);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not start robots or image work when all callers cancel before scheduling", async () => {
    const allowed = vi.fn();
    const http = new PublicHttpClient({ assertAllowed: allowed } as never);
    const controller = new AbortController();
    const first = expect(http.getImageDataUrl(target, referrer, { signal: controller.signal })).rejects.toThrow("leave now");
    const second = expect(http.getImageDataUrl(target, referrer, { signal: controller.signal })).rejects.toThrow("leave now");
    controller.abort(new Error("leave now"));
    await Promise.all([first, second]);
    expect(allowed).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("shares a failed response without caching the failure or duplicating a retry", async () => {
    network.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    const http = client();
    await Promise.all([
      expect(http.getImageDataUrl(target, referrer)).rejects.toThrow("503"),
      expect(http.getImageDataUrl(target, referrer)).rejects.toThrow("503")
    ]);
    network.fetch.mockImplementation(async () => response());
    await Promise.all([http.getImageDataUrl(target, referrer), http.getImageDataUrl(target, referrer)]);
    expect(network.fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps one deadline when a second reader joins a stalled response", async () => {
    vi.useFakeTimers();
    network.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const http = client();
    const first = expect(http.getImageDataUrl(target, referrer)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(10_000);
    const second = expect(http.getImageDataUrl(target, referrer)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(30_500);
    await Promise.all([first, second]);
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies robots restrictions for every redirect in a shared request", async () => {
    const redirected = "https://other.example/image.png";
    const allowed = vi.fn(async (url: string) => { if (url === redirected) throw new Error("fixture policy denies image"); });
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: redirected } }));
    const http = new PublicHttpClient({ assertAllowed: allowed } as never);
    await Promise.all([
      expect(http.getImageDataUrl(target, referrer)).rejects.toThrow("policy denies"),
      expect(http.getImageDataUrl(target, referrer)).rejects.toThrow("policy denies")
    ]);
    expect(allowed.mock.calls.map(([url]) => url)).toEqual([target, redirected]);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });
});
