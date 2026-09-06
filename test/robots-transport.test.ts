import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { RobotsPolicy, RobotsDisallowedError } from "../src/main/robots";

beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("robots transport boundary", () => {
  it("requires manual redirect handling before contacting the server", async () => {
    network.fetch.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://127.0.0.1/private" } }));
    await new RobotsPolicy().assertAllowed("https://example.com/post");
    expect(network.fetch).toHaveBeenCalledWith("https://example.com/robots.txt", expect.objectContaining({ redirect: "manual" }));
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat an oversized policy as permission to read a page", async () => {
    network.fetch.mockResolvedValueOnce(new Response("x".repeat(1_048_577)));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/post")).rejects.toThrow("robots.txt 超过");
  });

  it("does not cache a result that arrives after caller cancellation", async () => {
    const controller = new AbortController();
    network.fetch.mockImplementationOnce(async () => {
      controller.abort(new Error("cancel robots"));
      return new Response("User-agent: *\nDisallow: /");
    });
    const policy = new RobotsPolicy();
    await expect(policy.assertAllowed("https://example.com/post", { signal: controller.signal })).rejects.toThrow("cancel robots");
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /private"));
    await policy.assertAllowed("https://example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("ends a stalled body timeout and keeps the existing network-failure fallback", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    network.fetch.mockResolvedValueOnce(new Response(body));
    let settled = false;
    const pending = new RobotsPolicy().assertAllowed("https://example.com/post").then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(8_000);
      expect(settled).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    } finally {
      try { stream.close(); } catch { /* Already cancelled. */ }
      await pending;
    }
  });

  it.each(["https://127.0.0.1/private", "https://[::ffff:127.0.0.1]/private", "http://example.org/robots.txt", "https://user:secret@example.org/robots.txt"])("never follows an unsafe redirect to %s", async (location) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel }, { highWaterMark: 0 });
    network.fetch.mockResolvedValueOnce(new Response(body, { status: 302, headers: { location } }));
    await new RobotsPolicy().assertAllowed("https://example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("applies a cross-origin redirected policy to the original origin and caches it", async () => {
    network.fetch.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "https://cdn.example.org/policy.txt" } }));
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /private"));
    const policy = new RobotsPolicy();
    await expect(policy.assertAllowed("https://example.com/private/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    await policy.assertAllowed("https://example.com/public");
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(network.fetch.mock.calls[1][0]).toBe("https://cdn.example.org/policy.txt");
    network.fetch.mockResolvedValueOnce(new Response(""));
    await policy.assertAllowed("https://cdn.example.org/private/post");
    expect(network.fetch.mock.calls[2][0]).toBe("https://cdn.example.org/robots.txt");
  });

  it.each([5, 6])("bounds a chain of %i redirects", async (count) => {
    network.fetch.mockImplementation(async (url: string) => {
      const step = url.endsWith("robots.txt") ? 0 : Number(new URL(url).pathname.slice(2));
      return step < count
        ? new Response("", { status: 302, headers: { location: `/r${step + 1}` } })
        : new Response("User-agent: *\nDisallow: /");
    });
    const pending = new RobotsPolicy().assertAllowed("https://example.com/post");
    if (count === 5) await expect(pending).rejects.toBeInstanceOf(RobotsDisallowedError);
    else await pending;
    expect(network.fetch).toHaveBeenCalledTimes(6);
  });

  it("accepts the exact byte limit and rejects declared oversize before reading", async () => {
    const bytes = new Uint8Array(1_048_576).fill(32);
    bytes.set(new TextEncoder().encode("User-agent: *\nDisallow: /private\n"));
    network.fetch.mockResolvedValueOnce(new Response(bytes));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/private")).rejects.toBeInstanceOf(RobotsDisallowedError);
    const cancel = vi.fn();
    const pull = vi.fn();
    network.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel, pull }, { highWaterMark: 0 }), { headers: { "content-length": "1048577" } }));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/public")).rejects.toThrow("robots.txt 超过");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it("cancels a pending body without caching its partial policy, then retries", async () => {
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => { reading = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); return new Promise<void>(() => undefined); }, cancel }, { highWaterMark: 0 });
    network.fetch.mockResolvedValueOnce(new Response(body));
    const policy = new RobotsPolicy();
    const controller = new AbortController();
    const pending = policy.assertAllowed("https://example.com/post", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancel policy read");
    await entered;
    controller.abort(new Error("cancel policy read"));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /post"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses one deadline across redirects and discards a late response", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    network.fetch.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response("", { status: 302, headers: { location: "/next" } });
    });
    network.fetch.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
    });
    const pending = new RobotsPolicy().assertAllowed("https://example.com/post");
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([404, 503])("preserves the existing HTTP %i fallback and cache lifetime", async (status) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    network.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status }));
    const policy = new RobotsPolicy();
    await policy.assertAllowed("https://example.com/post");
    await policy.assertAllowed("https://example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });
});
