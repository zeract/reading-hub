import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  created: vi.fn(),
  configure: vi.fn(async () => undefined),
  navigate: vi.fn(async (_url?: string) => undefined),
  evaluate: vi.fn(async () => "Fixture HTML"),
  clear: vi.fn(async () => undefined),
  extract: vi.fn(() => [{ url: "https://www.zhihu.com/question/1/answer/2", title: "Fixture answer" }])
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    url = "https://www.zhihu.com/follow";
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.url, setWindowOpenHandler: vi.fn(), stop: vi.fn(), executeJavaScriptInIsolatedWorld: mocks.evaluate
    });
    loadURL = async (url: string) => { await mocks.navigate(url); this.url = url; };
    constructor(readonly options: unknown) { super(); mocks.windows.push(this); mocks.created(); }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  }
  return { BrowserWindow, session: { fromPartition: () => ({
    clearStorageData: mocks.clear, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn()
  }) } };
});
vi.mock("../src/main/network", () => ({ configureChromiumSession: mocks.configure }));
vi.mock("../src/main/zhihu-follow-parser", () => ({ extractZhihuFollowPage: mocks.extract }));
import { ZhihuFollowConnector } from "../src/main/zhihu-follow";

const read = (connector: ZhihuFollowConnector, kind: "feed" | "article") => kind === "feed"
  ? connector.fetchEntries() : connector.renderArticle("https://www.zhihu.com/question/1/answer/2");
function barrier<T>() {
  let release!: (value: T) => void;
  const wait = new Promise<T>((resolve) => { release = resolve; });
  return { wait, release };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.windows.length = 0;
  mocks.configure.mockResolvedValue(undefined); mocks.navigate.mockResolvedValue(undefined);
  mocks.evaluate.mockResolvedValue("Fixture HTML"); mocks.clear.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it("returns the actual Zhihu article address from the authorized session", async () => {
  const url = "https://zhuanlan.zhihu.com/p/12345";
  mocks.evaluate.mockImplementationOnce(async () => { mocks.windows.at(-1).url = url; return "Redirected HTML"; });
  const connector = new ZhihuFollowConnector();
  try {
    const pending = connector.renderArticle("https://www.zhihu.com/question/1/answer/2");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await pending).toEqual({ url, html: "Redirected HTML" });
    expect(mocks.windows.at(-1).isDestroyed()).toBe(true);
  } finally { connector.close(); }
});

it("rejects a final document outside the authorized Zhihu hosts", async () => {
  mocks.evaluate.mockImplementationOnce(async () => { mocks.windows.at(-1).url = "https://example.com/elsewhere"; return "Other HTML"; });
  const connector = new ZhihuFollowConnector();
  try {
    const rejected = expect(connector.renderArticle("https://www.zhihu.com/question/1/answer/2")).rejects.toThrow("只能在知乎授权会话中打开知乎内容");
    await vi.advanceTimersByTimeAsync(1_200);
    await rejected;
    expect(mocks.windows.at(-1).isDestroyed()).toBe(true);
  } finally { connector.close(); }
});

it("rechecks follow-page authorization after the DOM wait", async () => {
  mocks.evaluate.mockImplementationOnce(async () => { mocks.windows.at(-1).url = "https://www.zhihu.com/signin"; return "Login HTML"; });
  const connector = new ZhihuFollowConnector();
  try {
    const rejected = expect(connector.fetchEntries()).rejects.toThrow("知乎登录已失效");
    await vi.advanceTimersByTimeAsync(1_200);
    await rejected;
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.windows.at(-1).isDestroyed()).toBe(true);
  } finally { connector.close(); }
});

describe.each(["feed", "article"] as const)("Zhihu %s session lifetime", (kind) => {
  it("rejects an oversized document and releases its reading window", async () => {
    mocks.evaluate.mockResolvedValueOnce("x".repeat(8_000_001));
    const connector = new ZhihuFollowConnector();
    try {
      const rejected = expect(read(connector, kind)).rejects.toThrow("超过 8 MB");
      await vi.advanceTimersByTimeAsync(1_200);
      await rejected;
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(mocks.windows.at(-1).isDestroyed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { connector.close(); }
  });

  it("times out DOM extraction without waiting for a late result", async () => {
    const evaluated = barrier<string>();
    mocks.evaluate.mockImplementationOnce(() => evaluated.wait);
    const connector = new ZhihuFollowConnector();
    const settled = vi.fn();
    const pending = read(connector, kind).then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(6_200);
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "页面内容读取超时，请重试。" }));
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(mocks.windows.at(-1).isDestroyed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { evaluated.release("Late HTML"); await pending; connector.close(); }
  });

  it("owns a newly constructed window before the caller resumes", async () => {
    const connector = new ZhihuFollowConnector();
    let clearing: Promise<void> | undefined;
    mocks.created.mockImplementationOnce(() => { clearing = connector.clearSession(); });
    mocks.clear.mockImplementationOnce(async () => {
      expect(mocks.windows.every((window) => window.isDestroyed())).toBe(true);
    });
    const reading = read(connector, kind).catch((error) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await clearing;
      expect(await reading).toBeInstanceOf(Error);
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.windows).toHaveLength(1);
    } finally { await reading; connector.close(); }
  });

  it.each(["configuration", "navigation", "evaluation"] as const)("cancels %s and destroys old windows before clearing storage", async (phase) => {
    const configured = barrier<void>(); const navigated = barrier<void>(); const evaluated = barrier<string>();
    if (phase === "configuration") mocks.configure.mockImplementationOnce(() => configured.wait);
    if (phase === "navigation") mocks.navigate.mockImplementationOnce(() => navigated.wait);
    if (phase === "evaluation") mocks.evaluate.mockImplementationOnce(() => evaluated.wait);
    const connector = new ZhihuFollowConnector();
    let settled = false;
    const reading = read(connector, kind).catch((error) => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(1_200);
      mocks.clear.mockImplementationOnce(async () => {
        expect(mocks.windows.every((window) => window.isDestroyed())).toBe(true);
      });
      await connector.clearSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await reading).toBeInstanceOf(Error);
      configured.release(); navigated.release(); evaluated.release("Late HTML");
      await vi.advanceTimersByTimeAsync(1_200);
      expect(mocks.windows.every((window) => window.isDestroyed())).toBe(true);
      expect(mocks.extract).not.toHaveBeenCalled();
      if (phase !== "evaluation") expect(mocks.evaluate).not.toHaveBeenCalled();
    } finally {
      configured.release(); navigated.release(); evaluated.release("Late HTML");
      await vi.advanceTimersByTimeAsync(1_200); await reading; connector.close();
    }
  });

  it("waits for storage cleanup before creating a new reading window", async () => {
    const cleared = barrier<void>();
    mocks.clear.mockImplementationOnce(() => cleared.wait);
    const connector = new ZhihuFollowConnector();
    const clearing = connector.clearSession();
    const reading = read(connector, kind);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.configure).not.toHaveBeenCalled();
      cleared.release(); await clearing;
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await reading).toEqual(kind === "feed" ? mocks.extract.mock.results[0].value : { html: "Fixture HTML", url: "https://www.zhihu.com/question/1/answer/2" });
      expect(mocks.windows).toHaveLength(1);
      expect(mocks.windows[0].isDestroyed()).toBe(true);
    } finally { cleared.release(); await vi.advanceTimersByTimeAsync(1_200); await reading; connector.close(); }
  });

  it("cancels active reads and rejects future reads on close without logging out", async () => {
    const navigated = barrier<void>();
    mocks.navigate.mockImplementationOnce(() => navigated.wait);
    const connector = new ZhihuFollowConnector();
    let settled = false;
    const reading = read(connector, kind).catch((error) => error).finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      connector.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await reading).toBeInstanceOf(Error);
      await expect(read(connector, kind)).rejects.toThrow("退出");
      expect(mocks.windows).toHaveLength(1);
      expect(mocks.windows[0].isDestroyed()).toBe(true);
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally { navigated.release(); await vi.advanceTimersByTimeAsync(1_200); await reading; connector.close(); }
  });

  it("invalidates a waiting read when a second clear arrives", async () => {
    const cleared = barrier<void>();
    mocks.clear.mockImplementationOnce(() => cleared.wait);
    const connector = new ZhihuFollowConnector();
    const first = connector.clearSession();
    const reading = read(connector, kind).catch((error) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const second = connector.clearSession();
      expect(await reading).toBeInstanceOf(Error);
      expect(mocks.windows).toHaveLength(0);
      cleared.release(); await Promise.all([first, second]);
      const next = read(connector, kind);
      await vi.advanceTimersByTimeAsync(1_200); await next;
      expect(mocks.windows).toHaveLength(1);
      expect(mocks.clear).toHaveBeenCalledTimes(2);
    } finally { cleared.release(); await first; await reading; connector.close(); }
  });

  it("reports a failed cleanup to waiting reads and permits recovery after retry", async () => {
    mocks.clear.mockRejectedValueOnce(new Error("Synthetic storage failure"));
    const connector = new ZhihuFollowConnector();
    const clearing = connector.clearSession().catch((error) => error);
    const reading = read(connector, kind).catch((error) => error);
    try {
      expect((await clearing).message).toContain("会话清理失败");
      expect((await reading).message).toContain("会话清理失败");
      await expect(read(connector, kind)).rejects.toThrow("会话清理失败");
      expect(mocks.windows).toHaveLength(0);
      await connector.clearSession();
      const next = read(connector, kind);
      await vi.advanceTimersByTimeAsync(1_200); await next;
      expect(mocks.windows).toHaveLength(1);
    } finally { await clearing; await reading; connector.close(); }
  });
});
