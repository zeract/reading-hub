import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { RobotsDisallowedError, RobotsPolicy } from "../src/main/robots";
import { PublicHttpClient } from "../src/main/http";
import { IsolatedPageRenderer } from "../src/main/page-renderer";

beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("robots shared requests", () => {
  it("downloads one policy for concurrent paths on the same origin", async () => {
    network.fetch.mockImplementation(async () => new Response("User-agent: *\nDisallow: /private"));
    const policy = new RobotsPolicy();
    await Promise.all([
      policy.assertAllowed("https://example.com/public"),
      expect(policy.assertAllowed("https://example.com/private")).rejects.toBeInstanceOf(RobotsDisallowedError)
    ]);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not discard the shared download when one reader cancels", async () => {
    let finish!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let signal: AbortSignal | undefined;
    network.fetch.mockImplementation((_url, init) => {
      signal = init.signal;
      entered();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const policy = new RobotsPolicy();
    const controller = new AbortController();
    const first = expect(policy.assertAllowed("https://example.com/one", { signal: controller.signal })).rejects.toThrow("fixture cancel");
    const second = policy.assertAllowed("https://example.com/two");
    await started;
    controller.abort(new Error("fixture cancel"));
    await first;
    expect(signal?.aborted).toBe(false);
    finish(new Response(""));
    await second;
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels the last waiter immediately and keeps a replacement independent of late cleanup", async () => {
    const pending: { finish: (response: Response) => void; signal: AbortSignal }[] = [];
    network.fetch.mockImplementation((_url, init) => new Promise<Response>((finish) => {
      pending.push({ finish, signal: init.signal });
    }));
    const policy = new RobotsPolicy();
    const controller = new AbortController();
    const first = expect(policy.assertAllowed("https://example.com/old", { signal: controller.signal })).rejects.toThrow("stop old");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    controller.abort(new Error("stop old"));
    expect(pending[0].signal.aborted).toBe(true);
    const second = policy.assertAllowed("https://example.com/new");
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const discarded = vi.fn();
    pending[0].finish(new Response(new ReadableStream({ cancel: discarded }, { highWaterMark: 0 })));
    await vi.waitFor(() => expect(discarded).toHaveBeenCalledTimes(1));
    const third = policy.assertAllowed("https://example.com/third");
    pending[1].finish(new Response("User-agent: *\nDisallow: /old"));
    await Promise.all([second, third]);
    await expect(policy.assertAllowed("https://example.com/old")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not start a download when all waiters cancel before its microtask", async () => {
    const policy = new RobotsPolicy();
    const controller = new AbortController();
    const first = expect(policy.assertAllowed("https://example.com/one", { signal: controller.signal })).rejects.toThrow("cancel all");
    const second = expect(policy.assertAllowed("https://example.com/two", { signal: controller.signal })).rejects.toThrow("cancel all");
    controller.abort(new Error("cancel all"));
    await Promise.all([first, second]);
    expect(network.fetch).not.toHaveBeenCalled();
    network.fetch.mockResolvedValueOnce(new Response(""));
    await policy.assertAllowed("https://example.com/retry");
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps different origins independent", async () => {
    let finish!: (response: Response) => void;
    network.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    network.fetch.mockResolvedValueOnce(new Response(""));
    const policy = new RobotsPolicy();
    const slow = policy.assertAllowed("https://slow.example.com/post");
    await policy.assertAllowed("https://fast.example.com/post");
    finish(new Response(""));
    await slow;
  });

  it("releases caller abort listeners on shared success and error", async () => {
    const policy = new RobotsPolicy();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    network.fetch.mockResolvedValueOnce(new Response(""));
    await Promise.all([policy.assertAllowed("https://example.com/a", { signal: controller.signal }), policy.assertAllowed("https://example.com/b", { signal: controller.signal })]);
    network.fetch.mockRejectedValueOnce(new Error("fixture transport error"));
    await expect(policy.assertAllowed("https://other.example.com/a", { signal: controller.signal })).rejects.toBeInstanceOf(RobotsDisallowedError);
    for (const [event, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(event, listener);
  });

  it("shares a restriction across HTTP and renderer without requesting the article", async () => {
    network.fetch.mockImplementation(async () => new Response("User-agent: *\nDisallow: /"));
    const policy = new RobotsPolicy();
    const http = new PublicHttpClient(policy);
    const renderer = new IsolatedPageRenderer(policy);
    await Promise.all([
      expect(http.getText("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError),
      expect(renderer.render("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError)
    ]);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(network.fetch.mock.calls[0][0]).toBe("https://example.com/robots.txt");
  });
});

describe("robots bounded cache", () => {
  it("evicts the least recently used origin at the entry limit", async () => {
    network.fetch.mockImplementation(async () => new Response(""));
    const policy = new RobotsPolicy();
    for (let i = 0; i < 128; i++) await policy.assertAllowed(`https://site${i}.example.com/post`);
    await policy.assertAllowed("https://site0.example.com/post");
    await policy.assertAllowed("https://site128.example.com/post");
    await policy.assertAllowed("https://site0.example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(129);
    await policy.assertAllowed("https://site1.example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(130);
  });

  it("evicts by retained rule weight before reaching the entry limit", async () => {
    const text = `User-agent: *\nDisallow: /${"a".repeat(800_000)}`;
    network.fetch.mockImplementation(async () => new Response(text));
    const policy = new RobotsPolicy();
    for (let i = 0; i < 4; i++) await policy.assertAllowed(`https://large${i}.example.com/post`);
    await policy.assertAllowed("https://large3.example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(4);
    await policy.assertAllowed("https://large0.example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(5);
  });

  it("still enforces a policy too costly to retain", async () => {
    const text = `User-agent: *\nDisallow: /${"*".repeat(270_000)}private$`;
    network.fetch.mockImplementation(async () => new Response(text));
    const policy = new RobotsPolicy();
    await expect(policy.assertAllowed("https://example.com/private")).rejects.toBeInstanceOf(RobotsDisallowedError);
    await expect(policy.assertAllowed("https://example.com/private")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("reclaims expired failures before evicting a still-valid hot policy", async () => {
    vi.useFakeTimers();
    const policy = new RobotsPolicy();
    network.fetch.mockResolvedValueOnce(new Response(""));
    await policy.assertAllowed("https://valid.example.com/post");
    network.fetch.mockImplementation(async () => new Response("", { status: 503 }));
    for (let i = 0; i < 127; i++) await expect(policy.assertAllowed(`https://failed${i}.example.com/post`)).rejects.toBeInstanceOf(RobotsDisallowedError);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    network.fetch.mockResolvedValueOnce(new Response(""));
    await policy.assertAllowed("https://new.example.com/post");
    await policy.assertAllowed("https://valid.example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(129);
  });
});
