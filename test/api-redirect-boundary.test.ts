import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJsonWithTimeout } from "../src/main/json-response";
import { fetchApiResponse } from "../src/main/api-response";

afterEach(() => { vi.useRealTimers(); });

describe("API redirect boundary", () => {
  it("requires manual handling before sending an authenticated API request", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    await requestJsonWithTimeout(fetcher, "https://example.com/api", { headers: { authorization: "Bearer fixture-only" } }, undefined, 1000);
    expect(fetcher).toHaveBeenCalledWith("https://example.com/api", expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects a redirect outside the configured origin and releases its body", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
      status: 307, headers: { location: "https://127.0.0.1/private" }
    }));
    await expect(requestJsonWithTimeout(fetcher, "https://example.com/token", {
      method: "POST", body: "fixture-token-body"
    }, undefined, 1000)).rejects.toThrow("允许范围");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["https://other.example/api", "http://example.com/api", "https://example.com:444/api", "https://fixture:secret@example.com/api", "https://127.0.0.1/api", "https://[::1]/api", "file:///tmp/api", "https://["])("rejects target %s before a second request", async (location) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(fetchApiResponse(fetcher, "https://example.com/api", {})).rejects.toThrow("允许范围");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["http://example.com", "https://localhost/api", "https://fixture:secret@example.com", "bad url"])("rejects invalid initial address %s without fetching", async (url) => {
    const fetcher = vi.fn();
    await expect(fetchApiResponse(fetcher, url, {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([301, 302, 303])("converts POST %s to GET without retaining body headers or mutating the caller", async (status) => {
    const cancel = vi.fn();
    const initial: RequestInit = { method: "post", body: "fixture-body", headers: {
      authorization: "Bearer fixture-only", "content-type": "application/json", "content-length": "12",
      "content-language": "en", "content-location": "/old", "content-encoding": "gzip", accept: "application/json"
    } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status, headers: { location: "../next" } })).mockResolvedValueOnce(new Response("{}"));
    await requestJsonWithTimeout(fetcher, "https://example.com/api/start", initial, undefined, 1000);
    expect(fetcher.mock.calls[1][0]).toBe("https://example.com/next");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "GET", body: undefined, redirect: "manual" });
    expect(Object.fromEntries(new Headers(fetcher.mock.calls[1][1].headers))).toEqual({ authorization: "Bearer fixture-only", accept: "application/json" });
    expect(initial).toMatchObject({ method: "post", body: "fixture-body", headers: { "content-type": "application/json" } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([307, 308])("preserves a replayable OAuth body and authorization on same-origin %s", async (status) => {
    const body = new URLSearchParams({ code: "fixture-code" });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status, headers: { location: "/next" } })).mockResolvedValueOnce(new Response("{}"));
    await requestJsonWithTimeout(fetcher, "https://example.com/token", { method: "POST", body, headers: { authorization: "fixture-only" } }, undefined, 1000);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", body, headers: { authorization: "fixture-only" } });
    expect(fetcher.mock.calls[1][1].signal).toBe(fetcher.mock.calls[0][1].signal);
  });

  it.each(["HEAD", "GET"])("retains %s on a 303", async (method) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: "/next" } })).mockResolvedValueOnce(new Response(null));
    await fetchApiResponse(fetcher, "https://example.com/api", { method });
    expect(fetcher.mock.calls[1][1].method).toBe(method);
  });

  it("does not replay a consumed request stream", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { location: "/next" } }));
    await expect(fetchApiResponse(fetcher, "https://example.com/api", { method: "POST", body: new ReadableStream() })).rejects.toThrow("流式请求");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows five redirects and leaves the final body to its caller", async () => {
    const cancel = vi.fn();
    const final = new Response(new ReadableStream({ cancel }));
    let count = 0;
    const fetcher = vi.fn(async () => ++count <= 5 ? new Response(null, { status: 302, headers: { location: `/next/${count}` } }) : final);
    expect(await fetchApiResponse(fetcher, "https://example.com/api", {})).toBe(final);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(cancel).not.toHaveBeenCalled();
    await final.body!.cancel();
  });

  it("bounds redirect loops and releases every intermediate body", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: "/loop" } }));
    await expect(fetchApiResponse(fetcher, "https://example.com/api", {})).rejects.toThrow("次数过多");
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(cancel).toHaveBeenCalledTimes(6);
  });

  it("returns redirect status without Location for normal HTTP error handling", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 302 }));
    expect((await requestJsonWithTimeout(fetcher, "https://example.com/api", {}, undefined, 1000)).response.status).toBe(302);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not reset the deadline per hop and releases late headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response(null, { status: 307, headers: { location: "/next" } });
    }).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = expect(requestJsonWithTimeout(fetcher, "https://example.com/api", {}, undefined, 100)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    finish(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops before following when cancellation arrives with redirect headers", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => {
      controller.abort(new Error("fixture cancellation"));
      return new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: "/next" } });
    });
    await expect(fetchApiResponse(fetcher, "https://example.com/api", { signal: controller.signal })).rejects.toThrow("fixture cancellation");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(fetchApiResponse(fetcher, "https://example.com/api", { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
