import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { PublicHttpClient } from "../src/main/http";
const referrer = "https://example.com/article";
const url = (id: number) => `https://example.com/image-${id}.png`;
const response = () => new Response("fixture", { headers: { "content-type": "image/png" } });
const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("reader image admission", () => {
  it("runs at most four different downloads while other images wait", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    network.fetch.mockImplementation(async () => { await ready; return response(); });
    const http = client();
    const pending = Promise.all(Array.from({ length: 6 }, (_, i) => http.getImageDataUrl(url(i), referrer)));
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalled());
    try { expect(network.fetch).toHaveBeenCalledTimes(4); }
    finally { finish(); await pending; }
    expect(network.fetch).toHaveBeenCalledTimes(6);
  });

  it("bounds waiting tasks, admits duplicate readers, and serves cached images while saturated", async () => {
    const http = client();
    network.fetch.mockResolvedValueOnce(response());
    const cached = await http.getImageDataUrl(url(1000), referrer);
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    network.fetch.mockImplementation(async () => { await ready; return response(); });
    let overflow: Error | undefined;
    const pending = Array.from({ length: 69 }, (_, i) => http.getImageDataUrl(url(i), referrer).catch((error) => { overflow = error; return "rejected"; }));
    const duplicate = http.getImageDataUrl(url(0), referrer);
    await vi.waitFor(() => expect(overflow).toBeInstanceOf(Error));
    expect(overflow?.message).toContain("请求过多");
    expect(network.fetch).toHaveBeenCalledTimes(5); // One cached image and four active downloads.
    expect(await http.getImageDataUrl(url(1000), referrer)).toBe(cached);
    finish();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result === "rejected")).toHaveLength(1);
    expect(await duplicate).toBe(results[0]);
    expect(network.fetch).toHaveBeenCalledTimes(69);
    await expect(http.getImageDataUrl(url(68), referrer)).resolves.toContain("data:image/png;base64,");
    expect(network.fetch).toHaveBeenCalledTimes(70);
  });

  it("cancels a queued shared image before any robots or network work", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    network.fetch.mockImplementation(async () => { await ready; return response(); });
    const allowed = vi.fn().mockResolvedValue(undefined);
    const http = new PublicHttpClient({ assertAllowed: allowed } as never);
    const active = Promise.all(Array.from({ length: 4 }, (_, i) => http.getImageDataUrl(url(i), referrer)));
    const controller = new AbortController();
    const queued = expect(http.getImageDataUrl(url(4), referrer, { signal: controller.signal })).rejects.toThrow("leave queued image");
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(4));
    controller.abort(new Error("leave queued image")); await queued;
    const next = http.getImageDataUrl(url(5), referrer);
    finish(); await active; await next;
    expect(allowed.mock.calls.map(([target]) => target)).toEqual([url(0), url(1), url(2), url(3), url(5)]);
    expect(network.fetch).toHaveBeenCalledTimes(5);
  });

  it("keeps queued work when only one of its readers cancels", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    network.fetch.mockImplementation(async () => { await ready; return response(); });
    const http = client();
    const active = Promise.all(Array.from({ length: 4 }, (_, i) => http.getImageDataUrl(url(i), referrer)));
    const controller = new AbortController();
    const first = expect(http.getImageDataUrl(url(4), referrer, { signal: controller.signal })).rejects.toThrow("leave one");
    const second = http.getImageDataUrl(url(4), referrer);
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(4));
    controller.abort(new Error("leave one")); await first;
    finish(); await active;
    await expect(second).resolves.toContain("data:image/png;base64,");
    expect(network.fetch).toHaveBeenCalledTimes(5);
  });

  it("releases timed-out header slots and starts the next image with its own deadline", async () => {
    vi.useFakeTimers();
    network.fetch.mockImplementation(async (target) => target === url(4) ? response() : new Promise<Response>(() => undefined));
    const http = client();
    const active = Promise.all(Array.from({ length: 4 }, (_, i) => expect(http.getImageDataUrl(url(i), referrer)).rejects.toThrow("超时")));
    const queued = http.getImageDataUrl(url(4), referrer);
    await vi.advanceTimersByTimeAsync(20_000);
    await active; await expect(queued).resolves.toContain("data:image/png;base64,");
    expect(network.fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds slots through body reads and cancels active plus queued images when their owner closes", async () => {
    const pull = vi.fn(() => new Promise<void>(() => undefined)), cancel = vi.fn();
    network.fetch.mockImplementation(async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: { "content-type": "image/png" } }));
    const http = client(), controller = new AbortController();
    const pending = Promise.all(Array.from({ length: 6 }, (_, i) => expect(http.getImageDataUrl(url(i), referrer, { signal: controller.signal })).rejects.toThrow("owner closed")));
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(4));
    expect(network.fetch).toHaveBeenCalledTimes(4);
    controller.abort(new Error("owner closed"));
    await pending;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(4));
    expect(network.fetch).toHaveBeenCalledTimes(4);
    network.fetch.mockResolvedValueOnce(response());
    await expect(http.getImageDataUrl(url(4), referrer)).resolves.toContain("data:image/png;base64,");
    expect(network.fetch).toHaveBeenCalledTimes(5);
  });
});
