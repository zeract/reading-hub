import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: any[] = [];
  const renderState = {
    loadURL: (..._args: unknown[]) => new Promise<void>(() => undefined),
    executeJavaScript: (..._args: unknown[]) => Promise.resolve<unknown>(undefined)
  };
  class BrowserWindow {
    private destroyed = false;
    readonly webContents = {
      stop: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn((...args: unknown[]) => renderState.executeJavaScript(...args))
    };
    readonly loadURL = vi.fn((...args: unknown[]) => renderState.loadURL(...args));

    constructor() {
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
});
