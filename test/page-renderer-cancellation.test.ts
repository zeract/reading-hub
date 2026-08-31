import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: any[] = [];
  const renderState = {
    loadURL: (..._args: unknown[]) => new Promise<void>(() => undefined),
    executeJavaScript: (..._args: unknown[]) => Promise.resolve<unknown>(undefined)
  };
  class BrowserWindow {
    private destroyed = false;
    readonly listeners = new Map<string, (...args: any[]) => void>();
    readonly webContents = {
      stop: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => this.listeners.set(event, listener)),
      executeJavaScript: vi.fn((...args: unknown[]) => renderState.executeJavaScript(...args))
    };
    readonly loadURL = vi.fn((...args: unknown[]) => renderState.loadURL(...args));

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

describe("isolated page renderer cancellation", () => {
  it("stops and destroys the pending offscreen window on caller cancellation", async () => {
    electron.renderState.loadURL = (..._args: unknown[]) => new Promise<void>(() => undefined);
    const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const renderer = new IsolatedPageRenderer(robots as never);
    const controller = new AbortController();
    const rendering = renderer.render("https://example.com/article", { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const window = electron.windows[0];
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
    electron.renderState.executeJavaScript = (script: unknown, ..._args: unknown[]) => {
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
    electron.renderState.executeJavaScript = () => Promise.resolve("<html><body>safe</body></html>");
    const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const renderer = new IsolatedPageRenderer(robots as never);

    await expect(renderer.render("https://example.com/redirect")).resolves.toContain("safe");
    expect(robots.assertAllowed).toHaveBeenNthCalledWith(1, "https://example.com/redirect", { signal: undefined });
    expect(robots.assertAllowed).toHaveBeenNthCalledWith(2, "https://redirected.example/article", { signal: undefined });
  });
});
