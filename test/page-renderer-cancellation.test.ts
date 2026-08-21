import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: any[] = [];
  class BrowserWindow {
    private destroyed = false;
    readonly webContents = {
      stop: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn()
    };
    readonly loadURL = vi.fn(() => new Promise<void>(() => undefined));

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
    session: { fromPartition: vi.fn(() => isolatedSession) }
  };
});

vi.mock("electron", () => electron);
vi.mock("../src/main/network", () => ({ configureChromiumSession: vi.fn() }));

import { IsolatedPageRenderer } from "../src/main/page-renderer";

describe("isolated page renderer cancellation", () => {
  it("stops and destroys the pending offscreen window on caller cancellation", async () => {
    const renderer = new IsolatedPageRenderer();
    const controller = new AbortController();
    const rendering = renderer.render("https://example.com/article", { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const window = electron.windows[0];
    expect(window).toBeDefined();
    controller.abort(new Error("审计停止"));

    await expect(rendering).rejects.toThrow("审计停止");
    expect(window.webContents.stop).toHaveBeenCalledTimes(1);
    expect(window.isDestroyed()).toBe(true);
  });
});
