import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: any[] = [];
  const renderState = {
    loadURL: (..._args: unknown[]) => new Promise<void>(() => undefined),
    readDocument: (..._args: unknown[]) => Promise.resolve<unknown>(undefined)
  };
  class BrowserWindow {
    private destroyed = false;
    private url = "";
    readonly listeners = new Map<string, (...args: any[]) => void>();
    readonly webContents = {
      stop: vi.fn(),
      getURL: () => this.url,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => this.listeners.set(event, listener)),
      executeJavaScriptInIsolatedWorld: vi.fn((_world: number, scripts: Array<{ code: string }>) => renderState.readDocument(scripts[0].code))
    };
    readonly loadURL = vi.fn((...args: unknown[]) => { this.url = String(args[0]); return renderState.loadURL(...args); });

    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      windows.push(this);
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
    }
  }
  const isolatedSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined)
  };
  return {
    BrowserWindow,
    windows,
    renderState,
    session: { fromPartition: vi.fn(() => isolatedSession) }
  };
});

vi.mock("electron", () => electron);
vi.mock("../src/main/network", () => ({ configureChromiumSession: vi.fn() }));

import { IsolatedPageRenderer, RenderedPageTooLargeError } from "../src/main/page-renderer";
import { ArticleReader } from "../src/main/article-reader";
import { SourceProbe } from "../src/main/source-probe";
import { loadGenericPage } from "../src/main/generic-page-loader";
import type { Entry } from "../src/shared/types";
import { NetworkRequestError } from "../src/main/http";

afterEach(() => vi.useRealTimers());

function redirectedRenderer(html: string) {
  vi.useFakeTimers();
  electron.renderState.loadURL = (...args: unknown[]) => {
    if (args[0] === "https://example.com/entry") {
      electron.windows.at(-1).listeners.get("will-redirect")?.({ preventDefault() {} }, "https://publisher.example/posts/index.html", false, true);
      return Promise.reject(new Error("ERR_ABORTED"));
    }
    return Promise.resolve();
  };
  electron.renderState.readDocument = () => Promise.resolve(html);
  const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  return new IsolatedPageRenderer(robots as never);
}

describe("rendered page URL provenance", () => {
  it("returns the loaded page address together with its HTML", async () => {
    const renderer = redirectedRenderer("<p>Final page</p>");
    const pending = renderer.render("https://example.com/entry");
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toEqual({ url: "https://publisher.example/posts/index.html", html: "<p>Final page</p>" });
  });

  it("resolves article images and links against the rendered destination", async () => {
    const renderer = redirectedRenderer(`<article><h1>Fixture</h1><p>${"Readable content. ".repeat(50)}</p><img src="figure.png"><a href="appendix.html">Appendix details</a></article>`);
    const entry = { id: "fixture", title: "Fixture", url: "https://example.com/entry", canonicalUrl: "https://example.com/entry" } as Entry;
    const reader = new ArticleReader({ getText: async () => { throw new Error("Fixture unavailable"); } } as never, renderer);
    const pending = reader.read(entry);
    await vi.advanceTimersByTimeAsync(800);
    const article = await pending;
    expect(article.url).toBe("https://publisher.example/posts/index.html");
    expect(article.contentHtml).toContain('src="https://publisher.example/posts/figure.png"');
    expect(article.contentHtml).toContain('href="https://publisher.example/posts/appendix.html"');
  });

  it("preserves the final address when a source requires rendering on every refresh", async () => {
    const renderer = redirectedRenderer("<main>Fixture</main>");
    const http = { getText: vi.fn() };
    const pending = loadGenericPage(http as never, renderer, "https://example.com/entry", { preferRenderer: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toMatchObject({ url: "https://publisher.example/posts/index.html", text: "<main>Fixture</main>", fromRenderer: true });
    expect(http.getText).not.toHaveBeenCalled();
  });

  it("discovers a relative Feed at the rendered destination after static transport fails", async () => {
    const renderer = redirectedRenderer('<link rel="alternate" type="application/rss+xml" href="feed.xml"><main>Fixture</main>');
    const http = { getText: vi.fn(async (url: string) => {
      if (url === "https://example.com/entry") throw new NetworkRequestError();
      expect(url).toBe("https://publisher.example/posts/feed.xml");
      return { url, contentType: "application/rss+xml", text: '<rss version="2.0"><channel><title>Fixture Feed</title><description>Fixture</description><item><title>Fixture post</title><link>https://publisher.example/posts/first.html</link></item></channel></rss>' };
    }) };
    const pending = new SourceProbe(http as never, renderer).probe("https://example.com/entry");
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toMatchObject({ kind: "rss", url: "https://publisher.example/posts/feed.xml", title: "Fixture Feed" });
    expect(http.getText).toHaveBeenCalledTimes(2);
  });

  it.each(["probe", "calibrate"] as const)("keeps the chosen rendered source and relative cards together during %s", async (method) => {
    const renderer = redirectedRenderer(`<title>Rendered source</title><main><ul>
      <li><a href="first.html">A sufficiently descriptive first post</a><time datetime="2026-08-20">20 Aug 2026</time></li>
      <li><a href="second.html">A sufficiently descriptive second post</a><time datetime="2026-08-19">19 Aug 2026</time></li>
    </ul></main>`);
    const http = { getText: async () => ({ url: "https://example.com/entry", text: "<main>Loading</main>", contentType: "text/html" }) };
    const probe = new SourceProbe(http as never, renderer);
    const pending = probe[method]("https://example.com/entry");
    await vi.advanceTimersByTimeAsync(800);
    const result = await pending;
    expect(result.url).toBe("https://publisher.example/posts/index.html");
    expect(result.title).toBe("Rendered source");
    expect(JSON.stringify(result)).toContain("https://publisher.example/posts/first.html");
  });
});

describe("isolated page renderer cancellation", () => {
  it("stops and destroys the pending offscreen window on caller cancellation", async () => {
    electron.renderState.loadURL = (..._args: unknown[]) => new Promise<void>(() => undefined);
    const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const renderer = new IsolatedPageRenderer(robots as never);
    const controller = new AbortController();
    const rendering = renderer.render("https://example.com/article", { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const window = electron.windows.at(-1);
    expect(window).toBeDefined();
    expect(window.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true });
    controller.abort(new Error("审计停止"));

    await expect(rendering).rejects.toThrow("审计停止");
    expect(robots.assertAllowed).toHaveBeenCalledWith("https://example.com/article", { signal: controller.signal });
    expect(window.webContents.stop).toHaveBeenCalledTimes(1);
    expect(window.isDestroyed()).toBe(true);
  });

  it("keeps oversized rendered HTML inside the isolated renderer", async () => {
    electron.renderState.loadURL = (..._args: unknown[]) => Promise.resolve();
    electron.renderState.readDocument = (script: unknown, ..._args: unknown[]) => {
      expect(script).toContain("<= 5");
      return Promise.resolve(null);
    };
    const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const renderer = new IsolatedPageRenderer(robots as never);

    await expect(renderer.render("https://example.com/large", { maxBytes: 5 })).rejects.toBeInstanceOf(RenderedPageTooLargeError);
    expect(robots.assertAllowed).toHaveBeenCalledWith("https://example.com/large", { signal: undefined });
  });

  it("blocks an isolated renderer redirect to a private address before it can load", async () => {
    let prevented = false;
    electron.renderState.loadURL = (..._args: unknown[]) => {
      const window = electron.windows.at(-1);
      const event = { preventDefault: () => { prevented = true; } };
      window.listeners.get("will-redirect")?.(event, "http://127.0.0.1:4312/private", false, true);
      return Promise.reject(new Error("ERR_ABORTED"));
    };
    const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const renderer = new IsolatedPageRenderer(robots as never);

    await expect(renderer.render("https://example.com/redirect")).rejects.toThrow("不能添加本机或私有网络地址");
    expect(prevented).toBe(true);
    expect(robots.assertAllowed).toHaveBeenCalledTimes(1);
    expect(robots.assertAllowed).toHaveBeenCalledWith("https://example.com/redirect", { signal: undefined });
  });

  it("checks robots again before following a public renderer redirect", async () => {
    let redirected = false;
    electron.renderState.loadURL = (..._args: unknown[]) => {
      const window = electron.windows.at(-1);
      if (!redirected) {
        redirected = true;
        window.listeners.get("will-redirect")?.({ preventDefault: vi.fn() }, "https://redirected.example/article", false, true);
        return Promise.reject(new Error("ERR_ABORTED"));
      }
      return Promise.resolve();
    };
    electron.renderState.readDocument = () => Promise.resolve("<html><body>safe</body></html>");
    const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const renderer = new IsolatedPageRenderer(robots as never);

    await expect(renderer.render("https://example.com/redirect")).resolves.toEqual({ url: "https://redirected.example/article", html: "<html><body>safe</body></html>" });
    expect(robots.assertAllowed).toHaveBeenNthCalledWith(1, "https://example.com/redirect", { signal: undefined });
    expect(robots.assertAllowed).toHaveBeenNthCalledWith(2, "https://redirected.example/article", { signal: undefined });
  });
});
