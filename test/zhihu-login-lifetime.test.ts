import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  cookieListeners: new Set<() => void>(),
  cookies: vi.fn(async () => [] as Array<{ name: string }>),
  clear: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  configure: vi.fn(async () => undefined)
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    url = "https://www.zhihu.com/follow";
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.url, setWindowOpenHandler: vi.fn(), stop: vi.fn()
    });
    show = vi.fn();
    focus = vi.fn();
    loadURL = mocks.navigate;
    constructor(readonly options: unknown) { super(); mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroy(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  }
  return {
    BrowserWindow,
    session: { fromPartition: () => ({
      cookies: {
        get: mocks.cookies,
        on: (_event: string, listener: () => void) => mocks.cookieListeners.add(listener),
        removeListener: (_event: string, listener: () => void) => mocks.cookieListeners.delete(listener)
      },
      clearStorageData: mocks.clear,
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn()
    }) }
  };
});
vi.mock("../src/main/network", () => ({
  configureChromiumSession: mocks.configure,
  configureChromiumNetwork: vi.fn(async () => undefined),
  chromiumFetch: vi.fn(async () => { throw new Error("Unexpected network request in login fixture"); })
}));
import { ZhihuFollowConnector } from "../src/main/zhihu-follow";
import { createApplicationServices } from "../src/main/app-services";
import { ReadingDatabase } from "../src/main/database";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.windows.length = 0;
  mocks.cookieListeners.clear();
  mocks.cookies.mockResolvedValue([]);
  mocks.clear.mockResolvedValue(undefined);
  mocks.navigate.mockResolvedValue(undefined);
  mocks.configure.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("Zhihu login attempt lifetime", () => {
  it("coalesces concurrent login requests while the window is being configured", async () => {
    const configured: Array<() => void> = [];
    mocks.configure.mockImplementation(() => new Promise<void>((resolve) => { configured.push(resolve); }));
    const connector = new ZhihuFollowConnector();
    const first = connector.beginLogin();
    const second = connector.beginLogin();
    configured.forEach((resolve) => resolve());
    await Promise.all([first, second]);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(mocks.windows).toHaveLength(1);
    await connector.clearSession();
  });

  it("does not authenticate after the login window closes during the settle delay", async () => {
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(async () => undefined);
    connector.setOnAuthenticated(authenticated);
    await connector.beginLogin();
    await vi.advanceTimersByTimeAsync(0);
    mocks.windows[0].close();
    await vi.advanceTimersByTimeAsync(800);
    expect(authenticated).not.toHaveBeenCalled();
    expect(mocks.cookieListeners.size).toBe(0);
  });

  it("ignores a cookie lookup that returns after clearing the session", async () => {
    let cookies!: (value: Array<{ name: string }>) => void;
    mocks.cookies.mockImplementation(() => new Promise((resolve) => { cookies = resolve; }));
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(async () => undefined);
    connector.setOnAuthenticated(authenticated);
    await connector.beginLogin();
    await connector.clearSession();
    cookies([{ name: "z_c0" }]);
    await vi.advanceTimersByTimeAsync(800);
    expect(authenticated).not.toHaveBeenCalled();
  });

  it("cancels window creation when the session is cleared during network configuration", async () => {
    let configured!: () => void;
    mocks.configure.mockImplementationOnce(() => new Promise<void>((resolve) => { configured = resolve; }));
    const connector = new ZhihuFollowConnector();
    const opening = connector.beginLogin().catch((error) => error);
    await connector.clearSession();
    expect((await opening).message).toContain("已取消");
    configured();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.windows).toHaveLength(0);
    await connector.beginLogin();
    expect(mocks.windows).toHaveLength(1);
    connector.close();
  });

  it("waits for session deletion before opening a new login", async () => {
    let cleared!: () => void;
    mocks.clear.mockImplementationOnce(() => new Promise<void>((resolve) => { cleared = resolve; }));
    const connector = new ZhihuFollowConnector();
    const clearing = connector.clearSession();
    const opening = connector.beginLogin();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.configure).not.toHaveBeenCalled();
    cleared();
    await clearing;
    await opening;
    expect(mocks.windows).toHaveLength(1);
    connector.close();
  });

  it("invalidates a queued login when another clear arrives", async () => {
    let cleared!: () => void;
    mocks.clear.mockImplementationOnce(() => new Promise<void>((resolve) => { cleared = resolve; }));
    const connector = new ZhihuFollowConnector();
    const firstClear = connector.clearSession();
    const opening = connector.beginLogin().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const secondClear = connector.clearSession();
    expect((await opening).message).toContain("已取消");
    cleared();
    await Promise.all([firstClear, secondClear]);
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(mocks.windows).toHaveLength(0);
  });

  it("authenticates once despite repeated navigation and cookie events", async () => {
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(async () => undefined);
    connector.setOnAuthenticated(authenticated);
    await connector.beginLogin();
    for (const listener of mocks.cookieListeners) { listener(); listener(); }
    mocks.windows[0].webContents.emit("did-navigate", {}, "https://www.zhihu.com/follow");
    await vi.advanceTimersByTimeAsync(800);
    expect(authenticated).toHaveBeenCalledTimes(1);
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    expect(mocks.cookieListeners.size).toBe(0);
  });

  it("does not let an old callback completion close a newer login attempt", async () => {
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    let completed!: () => void;
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(() => new Promise<void>((resolve) => { completed = resolve; }));
    connector.setOnAuthenticated(authenticated);
    await connector.beginLogin();
    await vi.advanceTimersByTimeAsync(800);
    await connector.clearSession();
    mocks.cookies.mockResolvedValue([]);
    await connector.beginLogin();
    completed();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.windows[1].isDestroyed()).toBe(false);
    expect(mocks.cookieListeners.size).toBe(1);
    connector.close();
  });

  it("stops delayed authentication on shutdown and refuses future login attempts", async () => {
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(async () => undefined);
    connector.setOnAuthenticated(authenticated);
    await connector.beginLogin();
    connector.close();
    await vi.advanceTimersByTimeAsync(800);
    expect(authenticated).not.toHaveBeenCalled();
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    await expect(connector.beginLogin()).rejects.toThrow("应用正在退出");
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("cancels pending creation with its caller and rejects an already cancelled caller", async () => {
    let configured!: () => void;
    mocks.configure.mockImplementationOnce(() => new Promise<void>((resolve) => { configured = resolve; }));
    const connector = new ZhihuFollowConnector();
    const controller = new AbortController();
    const opening = connector.beginLogin(controller.signal).catch((error) => error);
    controller.abort();
    expect((await opening).message).toContain("已取消");
    configured();
    await vi.advanceTimersByTimeAsync(0);
    await expect(connector.beginLogin(controller.signal)).rejects.toThrow();
    expect(mocks.windows).toHaveLength(0);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });

  it("retains retry after a failed session clear and returns a fixed error", async () => {
    mocks.clear.mockRejectedValueOnce(new Error("fixture private session details"));
    const connector = new ZhihuFollowConnector();
    await expect(connector.clearSession()).rejects.toThrow("知乎会话清理失败，请重试取消订阅。");
    await connector.clearSession();
    await connector.beginLogin();
    expect(mocks.windows).toHaveLength(1);
    connector.close();
  });

  it("ignores a completed cookie check if the window navigated away during the settle delay", async () => {
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(async () => undefined);
    connector.setOnAuthenticated(authenticated);
    await connector.beginLogin();
    mocks.windows[0].url = "https://www.zhihu.com/signin";
    await vi.advanceTimersByTimeAsync(800);
    expect(authenticated).not.toHaveBeenCalled();
    connector.close();
  });

  it("keeps an unsubscribed source inactive after late login recognition and restart, then allows explicit login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-login-"));
    const databasePath = join(directory, "test.sqlite");
    const services = await createApplicationServices(databasePath);
    const sync = vi.spyOn(services.sync, "syncSource").mockResolvedValue({} as any);
    const source = services.sources.ensureZhihuFollowSource();
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    try {
      await services.sources.beginZhihuFollowLogin();
      await vi.advanceTimersByTimeAsync(0);
      await services.sources.setSubscribed(source.id, false);
      await vi.advanceTimersByTimeAsync(800);
      expect(services.database.getSource(source.id)?.subscribed).toBe(false);
      expect(sync).not.toHaveBeenCalled();
      await services.close();

      const reopened = new ReadingDatabase(databasePath);
      try { expect(reopened.getSource(source.id)?.subscribed).toBe(false); }
      finally { reopened.close(); }

      const resumed = await createApplicationServices(databasePath);
      const resumedSync = vi.spyOn(resumed.sync, "syncSource").mockResolvedValue({} as any);
      try {
        await resumed.sources.beginZhihuFollowLogin();
        await vi.advanceTimersByTimeAsync(800);
        expect(resumed.database.getSource(source.id)?.subscribed).toBe(true);
        expect(resumed.database.listSources()).toHaveLength(1);
        expect(resumedSync).toHaveBeenCalledTimes(1);
      } finally { await resumed.close(); }
    } finally { await services.close(); rmSync(directory, { recursive: true }); }
  });

  it("stops application login callbacks before IPC and database shutdown finish", async () => {
    const services = await createApplicationServices(":memory:");
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    await services.sources.beginZhihuFollowLogin();
    services.beginShutdown();
    await vi.advanceTimersByTimeAsync(800);
    expect(services.database.listSources()).toHaveLength(0);
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    await services.close();
  });

  it("cleans up a failed navigation and allows a new attempt without exposing its error", async () => {
    mocks.navigate.mockRejectedValueOnce(new Error("fixture private navigation details"));
    const connector = new ZhihuFollowConnector();
    await expect(connector.beginLogin()).rejects.toThrow("无法打开知乎登录窗口，请检查网络后重试。");
    expect(mocks.windows[0].isDestroyed()).toBe(true);
    expect(mocks.cookieListeners.size).toBe(0);
    await connector.beginLogin();
    expect(mocks.windows[1].isDestroyed()).toBe(false);
    connector.close();
  });

  it("keeps the login available after first-sync failure and logs no provider error details", async () => {
    mocks.cookies.mockResolvedValue([{ name: "z_c0" }]);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connector = new ZhihuFollowConnector();
    const authenticated = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("fixture-private-provider-details"));
    connector.setOnAuthenticated(authenticated);
    try {
      await connector.beginLogin();
      await vi.advanceTimersByTimeAsync(800);
      expect(log).toHaveBeenCalledWith("知乎登录识别或首次同步失败，请重新登录后重试。");
      expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-private-provider-details");
      expect(mocks.windows[0].isDestroyed()).toBe(false);
      mocks.windows[0].webContents.emit("did-navigate", {}, "https://www.zhihu.com/follow");
      await vi.advanceTimersByTimeAsync(800);
      expect(authenticated).toHaveBeenCalledTimes(2);
      expect(mocks.windows[0].isDestroyed()).toBe(true);
    } finally { connector.close(); log.mockRestore(); }
  });
});
