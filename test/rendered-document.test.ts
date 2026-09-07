import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRenderedPage, RenderedPageTooLargeError } from "../src/main/rendered-document";

const url = "https://example.com/article";
function fixture(html: string) {
  const transferred: unknown[] = [];
  const contents = {
    getURL: vi.fn(() => url),
    executeJavaScriptInIsolatedWorld: vi.fn(async (world: number, scripts: Array<{ code: string }>, userGesture?: boolean) => {
      expect(world).not.toBe(0);
      expect(world).not.toBe(999);
      expect(userGesture).not.toBe(true);
      const value: unknown = runInNewContext(scripts[0].code, { document: { documentElement: { outerHTML: html } }, Blob });
      transferred.push(value);
      return value;
    })
  };
  return { contents, transferred };
}
afterEach(() => vi.useRealTimers());

describe("bounded rendered document capture", () => {
  it("accepts the exact UTF-8 limit and preserves the document address", async () => {
    const html = "<p>中文 🧪</p>";
    const { contents, transferred } = fixture(html);
    await expect(readRenderedPage(contents, { maxBytes: Buffer.byteLength(html) })).resolves.toEqual({ url, html });
    expect(transferred).toEqual([html]);
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
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce("中".repeat(4));
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
