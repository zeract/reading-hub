import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeRenderedPage, readRenderedPage, RenderedPageTooLargeError } from "../src/main/rendered-document";

const url = "https://example.com/article";
function fixture(html: string) {
  const transferred: unknown[] = [];
  const contents = {
    getURL: vi.fn(() => url),
    executeJavaScriptInIsolatedWorld: vi.fn(async (world: number, scripts: Array<{ code: string }>, userGesture?: boolean) => {
      expect(world).not.toBe(0);
      expect(world).not.toBe(999);
      expect(userGesture).not.toBe(true);
      const value: unknown = runInNewContext(scripts[0].code, { document: { URL: url, documentElement: { outerHTML: html } }, Blob });
      transferred.push(value);
      return value;
    })
  };
  return { contents, transferred };
}
afterEach(() => vi.useRealTimers());

describe("observed main document response", () => {
  it("allows a same-document history update without reassigning the snapshot URL", async () => {
    const contents = Object.assign(new EventEmitter(), fixture("<article>Original snapshot</article>").contents);
    const evaluate = contents.executeJavaScriptInIsolatedWorld.getMockImplementation()!;
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async (...args) => {
      const snapshot = await evaluate(...args);
      contents.getURL.mockReturnValue("https://example.com/new-history-path");
      contents.emit("did-navigate-in-page", {}, contents.getURL(), true);
      return snapshot;
    });
    const capture = observeRenderedPage(contents as never);
    contents.emit("did-navigate", {}, url, 200, "OK");
    try { expect(await capture.read()).toEqual({ html: "<article>Original snapshot</article>", url }); }
    finally { capture.dispose(); }
  });

  it.each([url, "https://example.com/replacement"])("rejects a different successful document committed during capture (%s)", async (destination) => {
    const contents = Object.assign(new EventEmitter(), fixture("<article>Old document</article>").contents);
    const evaluate = contents.executeJavaScriptInIsolatedWorld.getMockImplementation()!;
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async (...args) => {
      const snapshot = await evaluate(...args);
      contents.emit("did-navigate", {}, destination, 200, "OK");
      return snapshot;
    });
    const capture = observeRenderedPage(contents as never);
    contents.emit("did-navigate", {}, url, 200, "OK");
    try { await expect(capture.read()).rejects.toThrow("页面在读取过程中发生跳转，请重试。"); }
    finally { capture.dispose(); }
  });

  it("does not let a later 200 response erase an intervening document replacement", async () => {
    const contents = Object.assign(new EventEmitter(), fixture("<article>Old document</article>").contents);
    const evaluate = contents.executeJavaScriptInIsolatedWorld.getMockImplementation()!;
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async (...args) => {
      const snapshot = await evaluate(...args);
      contents.emit("did-navigate", {}, url, 503, "Unavailable");
      contents.emit("did-navigate", {}, url, 200, "OK");
      return snapshot;
    });
    const capture = observeRenderedPage(contents as never);
    contents.emit("did-navigate", {}, url, 200, "OK");
    try { await expect(capture.read()).rejects.toThrow("页面在读取过程中发生跳转，请重试。"); }
    finally { capture.dispose(); }
  });

  it("accepts a successful main document despite a failing child frame", async () => {
    const contents = Object.assign(new EventEmitter(), fixture("<article>404 is discussed in this article</article>").contents);
    const capture = observeRenderedPage(contents as never);
    try {
      contents.emit("did-navigate", {}, url, 200, "OK");
      contents.emit("did-frame-navigate", {}, "https://example.com/child", 404, "Not found", false);
      expect(await capture.read()).toMatchObject({ url, html: "<article>404 is discussed in this article</article>" });
    } finally { capture.dispose(); }
  });

  it("preserves caller cancellation over a previously observed HTTP error", async () => {
    const contents = Object.assign(new EventEmitter(), fixture("Unused").contents);
    const capture = observeRenderedPage(contents as never);
    const caller = new AbortController();
    const reason = new Error("Fixture cancelled");
    contents.emit("did-navigate", {}, url, 403, "Remote diagnostic");
    caller.abort(reason);
    try {
      await expect(capture.read({ signal: caller.signal })).rejects.toBe(reason);
      expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    } finally { capture.dispose(); }
  });

  it("releases only its own navigation listener", () => {
    const contents = Object.assign(new EventEmitter(), fixture("Unused").contents);
    const other = vi.fn();
    contents.on("did-navigate", other);
    const capture = observeRenderedPage(contents as never);
    expect(contents.listenerCount("did-navigate")).toBe(2);
    capture.dispose(); capture.dispose();
    expect(contents.listeners("did-navigate")).toEqual([other]);
  });
});

describe("bounded rendered document capture", () => {
  it.each(["legacy HTML", [], {}, { html: "text" }, { url }, { html: 42, url }, { html: "text", url: 42 }])("rejects malformed snapshot payload %j", async (payload) => {
    const { contents } = fixture("");
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(payload);
    await expect(readRenderedPage(contents)).rejects.toThrow("页面内容读取失败，请重试。");
  });

  it.each(["http://127.0.0.1/private", "https://user:fixture@example.com/article", "file:///tmp/fixture.html", "data:text/html,fixture"])("rejects an unsafe captured document URL %s", async (capturedUrl) => {
    const { contents } = fixture("");
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({ html: "Fixture", url: capturedUrl });
    await expect(readRenderedPage(contents)).rejects.toBeInstanceOf(Error);
    expect(contents.getURL).not.toHaveBeenCalled();
  });

  it("keeps the URL captured with the HTML when history changes before IPC returns", async () => {
    const html = "<article>Original snapshot</article>";
    const { contents } = fixture(html);
    const evaluate = contents.executeJavaScriptInIsolatedWorld.getMockImplementation()!;
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async (...args) => {
      const snapshot = await evaluate(...args);
      contents.getURL.mockReturnValue("https://example.com/changed-by-history");
      return snapshot;
    });
    expect(await readRenderedPage(contents)).toEqual({ html, url });
  });

  it("accepts the exact UTF-8 limit and preserves the document address", async () => {
    const html = "<p>中文 🧪</p>";
    const { contents, transferred } = fixture(html);
    await expect(readRenderedPage(contents, { maxBytes: Buffer.byteLength(html) })).resolves.toEqual({ url, html });
    expect(transferred).toEqual([{ html, url }]);
  });

  it("rejects one byte over the limit without transferring the HTML", async () => {
    const html = "<p>中文 🧪</p>";
    const { contents, transferred } = fixture(html);
    await expect(readRenderedPage(contents, { maxBytes: Buffer.byteLength(html) - 1 })).rejects.toBeInstanceOf(RenderedPageTooLargeError);
    expect(transferred).toEqual([null]);
    expect(contents.getURL).not.toHaveBeenCalled();
  });

  it("enforces the default budget before transferring a large DOM", async () => {
    const { contents, transferred } = fixture("x".repeat(8_000_001));
    await expect(readRenderedPage(contents)).rejects.toBeInstanceOf(RenderedPageTooLargeError);
    expect(transferred).toEqual([null]);
  });

  it("checks the returned bytes again if a transport violates the script contract", async () => {
    const { contents } = fixture("");
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({ html: "中".repeat(4), url });
    await expect(readRenderedPage(contents, { maxBytes: 10 })).rejects.toBeInstanceOf(RenderedPageTooLargeError);
  });

  it("distinguishes a missing execution result from an oversized DOM", async () => {
    const { contents } = fixture("");
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(undefined);
    await expect(readRenderedPage(contents)).rejects.toThrow("页面内容读取失败，请重试。");
  });

  it("does not dispatch an already-cancelled capture", async () => {
    const { contents } = fixture("<p>Unused</p>");
    const controller = new AbortController(); controller.abort(new Error("Fixture cancelled"));
    await expect(readRenderedPage(contents, { signal: controller.signal })).rejects.toThrow("Fixture cancelled");
    expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("stops a pending capture and cannot publish its late address", async () => {
    vi.useFakeTimers();
    const { contents } = fixture("");
    let release!: (value: unknown) => void;
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const rejected = expect(readRenderedPage(contents, { signal: controller.signal })).rejects.toThrow("Fixture cancelled");
    controller.abort(new Error("Fixture cancelled"));
    await rejected;
    release("Late HTML"); await vi.advanceTimersByTimeAsync(0);
    expect(contents.getURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
