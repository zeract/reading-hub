import { describe, expect, it, vi } from "vitest";
import { SourceProbe } from "../src/main/source-probe";
const page = (url: string, text = "<html><title>Fixture</title><body>Loading</body></html>", contentType = "text/html") => ({ url, text, contentType, status: 200 });
const rss = '<rss version="2.0"><channel><title>Fixture</title><link>https://example.com/</link><item><title>Fixture post</title><link>https://example.com/post</link></item></channel></rss>';

describe("source probe cancellation", () => {
  it.each(["probe", "calibrate"] as const)("does not start a cancelled %s", async (method) => {
    const controller = new AbortController(); controller.abort(new Error("cancel probe"));
    const http = { getText: vi.fn(async (url: string) => page(url)) };
    await expect(new SourceProbe(http as never)[method]("https://example.com/", controller.signal)).rejects.toThrow("cancel probe");
    expect(http.getText).not.toHaveBeenCalled();
  });

  it("does not try the next alternate Feed after cancellation", async () => {
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string) => {
      if (url === "https://example.com/") return page(url, '<link rel="alternate" type="application/rss+xml" href="/first.xml"><link rel="alternate" type="application/rss+xml" href="/second.xml">');
      if (url.endsWith("first.xml")) { controller.abort(new Error("cancel probe")); throw new Error("fixture failure"); }
      return page(url, rss, "application/rss+xml");
    }) };
    await expect(new SourceProbe(http as never).probe("https://example.com/", controller.signal)).rejects.toThrow("cancel probe");
    expect(http.getText).toHaveBeenCalledTimes(2);
  });

  it.each(["probe", "calibrate"] as const)("does not turn cancelled rendering into a successful %s fallback", async (method) => {
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string) => page(url)) };
    const renderer = { render: vi.fn(async () => { controller.abort(new Error("cancel probe")); throw new Error("fixture renderer failure"); }) };
    await expect(new SourceProbe(http as never, renderer)[method]("https://example.com/", controller.signal)).rejects.toThrow("cancel probe");
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it("does not swallow cancellation during optional archive discovery", async () => {
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string) => {
      if (url.endsWith("feed.xml")) return page(url, rss, "application/rss+xml");
      controller.abort(new Error("cancel probe")); throw new Error("fixture homepage failure");
    }) };
    await expect(new SourceProbe(http as never).probe("https://example.com/feed.xml", controller.signal)).rejects.toThrow("cancel probe");
  });

  it.each(["probe", "calibrate"] as const)("rejects a late successful renderer result during %s", async (method) => {
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string) => page(url)) };
    const renderer = { render: vi.fn(async (_url: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error("cancel probe")); return { url: _url, html: "<main>Late fixture page</main>" };
    }) };
    await expect(new SourceProbe(http as never, renderer)[method]("https://example.com/", controller.signal)).rejects.toThrow("cancel probe");
  });

  it("passes cancellation to a trusted local Feed without following its homepage", async () => {
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string, _cached, options) => {
      expect(options).toMatchObject({ allowTrustedLoopbackFeed: true, signal: controller.signal });
      controller.abort(new Error("cancel probe")); return page(url, rss, "application/rss+xml");
    }) };
    await expect(new SourceProbe(http as never).probe("http://127.0.0.1:1200/feed", controller.signal)).rejects.toThrow("cancel probe");
    expect(http.getText).toHaveBeenCalledTimes(1);
  });

  it("does not begin fallback work when the initial page completes after cancellation", async () => {
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string) => { controller.abort(new Error("cancel probe")); return page(url); }) };
    const renderer = { render: vi.fn() };
    await expect(new SourceProbe(http as never, renderer).probe("https://example.com/", controller.signal)).rejects.toThrow("cancel probe");
    expect(renderer.render).not.toHaveBeenCalled();
    expect(http.getText).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary archive failures optional and supports retry after cancellation", async () => {
    let cancel = true;
    const controller = new AbortController();
    const http = { getText: vi.fn(async (url: string) => {
      if (url.endsWith("feed.xml")) return page(url, rss, "application/rss+xml");
      if (cancel) controller.abort(new Error("cancel probe"));
      throw new Error("fixture homepage offline");
    }) };
    const probe = new SourceProbe(http as never);
    await expect(probe.probe("https://example.com/feed.xml", controller.signal)).rejects.toThrow("cancel probe");
    cancel = false;
    await expect(probe.probe("https://example.com/feed.xml", new AbortController().signal)).resolves.toMatchObject({ kind: "rss", historicalArchiveUrl: undefined, preview: [{ title: "Fixture post" }] });
  });

});
