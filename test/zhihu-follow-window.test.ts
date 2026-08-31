import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: Array<{ options: Record<string, unknown>; isDestroyed(): boolean; destroy(): void; webContents: Record<string, ReturnType<typeof vi.fn>> }> = [];
  class BrowserWindow {
    private destroyed = false;
    readonly options: Record<string, unknown>;
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    };

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
    setPermissionCheckHandler: vi.fn()
  };
  return {
    BrowserWindow,
    windows,
    session: { fromPartition: vi.fn(() => isolatedSession) }
  };
});

vi.mock("electron", () => electron);
vi.mock("../src/main/network", () => ({ configureChromiumSession: vi.fn().mockResolvedValue(undefined) }));

import { ZhihuFollowConnector } from "../src/main/zhihu-follow";

describe("Zhihu follow session windows", () => {
  it("uses a non-activating offscreen window for automatic sync and reader requests", async () => {
    const connector = new ZhihuFollowConnector();
    const createWindow = connector as unknown as { createWindow(show: boolean): Promise<{ options: Record<string, unknown>; destroy(): void }> };

    const window = await createWindow.createWindow(false);

    expect(window.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true });
    window.destroy();
  });

  it("keeps the explicit login window visible and focusable", async () => {
    const connector = new ZhihuFollowConnector();
    const createWindow = connector as unknown as { createWindow(show: boolean): Promise<{ options: Record<string, unknown>; destroy(): void }> };

    const window = await createWindow.createWindow(true);

    expect(window.options).toMatchObject({ show: true });
    expect(window.options.focusable).toBeUndefined();
    expect(window.options.skipTaskbar).toBeUndefined();
    window.destroy();
  });
});
