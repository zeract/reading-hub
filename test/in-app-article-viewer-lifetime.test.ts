import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const isolatedSession = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => undefined)
  };
  const window = {
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
    once: vi.fn(), setTitle: vi.fn(), loadURL: vi.fn(async () => undefined)
  };
  return {
    isolatedSession, window,
    fromPartition: vi.fn(() => isolatedSession),
    BrowserWindow: vi.fn(function () { return window; }),
    configure: vi.fn(async () => undefined)
  };
});
vi.mock("electron", () => ({ BrowserWindow: mocks.BrowserWindow, session: { fromPartition: mocks.fromPartition } }));
vi.mock("../src/main/network", () => ({ configureChromiumSession: mocks.configure }));
import { InAppArticleViewer } from "../src/main/in-app-article-viewer";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configure.mockResolvedValue(undefined);
});

describe("original-page window lifetime", () => {
  it.each(["resolve", "reject"])("never creates a late window when configuration later %ss", async (completion) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    mocks.configure.mockImplementationOnce(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    const controller = new AbortController();
    const pending = new InAppArticleViewer().open("https://example.com/post", "Fixture", controller.signal);
    controller.abort(new Error("Owner closed"));
    await expect(pending).rejects.toThrow("Owner closed");
    if (completion === "resolve") resolve(); else reject(new Error("Late configuration failure"));
    await Promise.resolve();
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
  });

  it("does not allocate a session for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Owner closed"));
    await expect(new InAppArticleViewer().open("https://example.com/post", "Fixture", controller.signal)).rejects.toThrow("Owner closed");
    expect(mocks.fromPartition).not.toHaveBeenCalled();
  });

  it("preserves the isolated original-page window and navigation", async () => {
    await new InAppArticleViewer().open("https://example.com/post", "Fixture");
    expect(mocks.configure).toHaveBeenCalledWith(mocks.isolatedSession);
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      webPreferences: expect.objectContaining({ sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false })
    }));
    expect(mocks.window.loadURL).toHaveBeenCalledWith("https://example.com/post");
    const closed = mocks.window.once.mock.calls.find(([event]) => event === "closed")![1];
    closed();
    expect(mocks.isolatedSession.clearStorageData).toHaveBeenCalledTimes(1);
  });

  it("rejects private destinations before configuring the session", async () => {
    await expect(new InAppArticleViewer().open("https://127.0.0.1/post", "Fixture")).rejects.toThrow();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
  });
});

describe("original-page navigation policy", () => {
  it.each(["will-navigate", "will-redirect"])("validates every %s destination", async (name) => {
    await new InAppArticleViewer().open("https://example.com/post", "Fixture");
    const listener = mocks.window.webContents.on.mock.calls.find(([event]) => event === name)?.[1];
    expect(listener).toBeTypeOf("function");
    for (const url of ["https://127.0.0.1/private", "http://192.168.1.1/", "file:///tmp/fixture", "https://user:fixture@example.com/"]) {
      const event = { preventDefault: vi.fn() };
      listener!(event, url, false, true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
    const event = { preventDefault: vi.fn() };
    listener!(event, "https://other.example.org/article", false, true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    if (name === "will-redirect") {
      // This document guard must not silently change existing subframe policy.
      listener!(event, "https://127.0.0.1/frame-fixture", false, false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});
