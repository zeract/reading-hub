import { describe, expect, it, vi } from "vitest";

const chromiumFetch = vi.hoisted(() => vi.fn());

vi.mock("../src/main/network", () => ({ chromiumFetch }));

import { PublicHttpClient, ResponseTooLargeError } from "../src/main/http";

describe("PublicHttpClient local-feed boundary", () => {
  it("reads only an explicitly enabled loopback Feed without consulting remote robots", async () => {
    const robots = { assertAllowed: vi.fn() };
    chromiumFetch.mockResolvedValueOnce(new Response("<rss version=\"2.0\"><channel /></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    }));

    const client = new PublicHttpClient(robots as never);
    await expect(client.getText("http://127.0.0.1:1200/twitter/user/example", undefined, {
      allowTrustedLoopbackFeed: true
    })).resolves.toMatchObject({ status: 200, contentType: "application/rss+xml" });

    expect(robots.assertAllowed).not.toHaveBeenCalled();
    expect(chromiumFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:1200/twitter/user/example",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("does not permit a local Feed to escape its loopback origin through redirects", async () => {
    const robots = { assertAllowed: vi.fn() };
    chromiumFetch.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://example.com/feed.xml" }
    }));
    const client = new PublicHttpClient(robots as never);

    await expect(client.getText("http://127.0.0.1:1200/feed", undefined, {
      allowTrustedLoopbackFeed: true
    })).rejects.toThrow("本机 Feed 不能重定向到其他地址");
  });

  it("aborts an in-flight public request when an audit signal is cancelled", async () => {
    const robots = { assertAllowed: vi.fn() };
    let requestSignal: AbortSignal | undefined;
    chromiumFetch.mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<never>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    }));
    const client = new PublicHttpClient(robots as never);
    const controller = new AbortController();
    const request = client.getText("https://example.com/article", undefined, { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestSignal).toBeDefined();
    controller.abort(new Error("审计停止"));

    await expect(request).rejects.toThrow("审计停止");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("reports an oversized declared HTML response as a typed bounded-read error", async () => {
    const robots = { assertAllowed: vi.fn() };
    chromiumFetch.mockResolvedValueOnce(new Response("<html></html>", {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": "3000001"
      }
    }));
    const client = new PublicHttpClient(robots as never);

    await expect(client.getText("https://example.com/large-page")).rejects.toMatchObject({
      name: "ResponseTooLargeError",
      maxBytes: 3_000_000,
      contentType: "text/html; charset=utf-8",
      url: "https://example.com/large-page",
      receivedBytes: 3_000_001
    } satisfies Partial<ResponseTooLargeError>);
  });

  it("counts streamed UTF-8 response bytes instead of JavaScript string length", async () => {
    const robots = { assertAllowed: vi.fn() };
    const cancellation = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("你"));
        controller.enqueue(new TextEncoder().encode("好"));
      },
      cancel: cancellation
    });
    chromiumFetch.mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "content-type": "text/html" }
    }));
    const client = new PublicHttpClient(robots as never);

    await expect(client.getText("https://example.com/utf8", undefined, { maxBytes: 5 })).rejects.toMatchObject({
      name: "ResponseTooLargeError",
      maxBytes: 5,
      receivedBytes: 6
    } satisfies Partial<ResponseTooLargeError>);
    expect(cancellation).toHaveBeenCalledTimes(1);
  });
});
