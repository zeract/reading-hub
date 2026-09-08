import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const windows: any[] = [];
  const sessions: any[] = [];
  const configure = vi.fn();
  const cleanup = vi.fn();
  const navigate = vi.fn();
  const capture = vi.fn();
  class BrowserWindow {
    destroyed = false;
    url = "";
    listeners = new Map<string, (...args: any[]) => void>();
    webContents = {
      stop: vi.fn(),
      getURL: () => this.url,
      setWindowOpenHandler: vi.fn(),
      on: (event: string, listener: (...args: any[]) => void) => this.listeners.set(event, listener),
      removeListener: (event: string) => this.listeners.delete(event),
      executeJavaScriptInIsolatedWorld: async () => { const html = await capture(); return typeof html === "string" ? { html, url: this.url } : html; }
    };
    constructor() { windows.push(this); }
    async loadURL(url: string) { this.url = url; await navigate(this); if (fixture.status !== undefined) this.listeners.get("did-navigate")?.({}, url, fixture.status, "Untrusted remote status"); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  return { windows, sessions, configure, cleanup, navigate, capture, BrowserWindow, status: 200 as number | undefined };
});
vi.mock("electron", () => ({
  BrowserWindow: fixture.BrowserWindow,
  session: { fromPartition: () => {
    const value = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      clearStorageData: vi.fn(() => fixture.cleanup())
    };
    fixture.sessions.push(value);
    return value;
  } }
}));
vi.mock("../src/main/network", () => ({ configureChromiumSession: fixture.configure }));

import { IsolatedPageRenderer } from "../src/main/page-renderer";
import { GenericConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager } from "../src/main/sync-manager";
import { ArticleReader } from "../src/main/article-reader";
import type { Entry, Source } from "../src/shared/types";

const never = () => new Promise<void>(() => undefined);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const robots = () => ({ assertAllowed: vi.fn().mockResolvedValue(undefined) });

beforeEach(() => {
  vi.useFakeTimers();
  fixture.status = 200;
  fixture.windows.length = 0;
  fixture.sessions.length = 0;
  fixture.configure.mockReset().mockResolvedValue(undefined);
  fixture.cleanup.mockReset().mockResolvedValue(undefined);
  fixture.navigate.mockReset().mockResolvedValue(undefined);
  fixture.capture.mockReset().mockResolvedValue("<p>Public document</p>");
});
afterEach(() => vi.useRealTimers());

describe("public rendering task lifetime", () => {
  it("retains the shorter navigation deadline and destroys its window", async () => {
    fixture.navigate.mockImplementationOnce(never);
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article").catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toMatchObject({ message: "页面渲染超时，请检查网络后重试。" });
    expect(fixture.windows[0].webContents.stop).toHaveBeenCalledOnce();
    expect(fixture.windows[0].isDestroyed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels promptly while successful rendering is awaiting cleanup", async () => {
    fixture.cleanup.mockImplementationOnce(never);
    const caller = new AbortController();
    const reason = new Error("User cancelled cleanup wait");
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article", { signal: caller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(fixture.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    caller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(fixture.windows[0].isDestroyed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a session when robots rejects access", async () => {
    const policy = robots();
    const reason = new Error("Policy denied");
    policy.assertAllowed.mockRejectedValueOnce(reason);
    await expect(new IsolatedPageRenderer(policy as never).render("https://example.com/article")).rejects.toBe(reason);
    expect(fixture.sessions).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["robots", "configuration", "cleanup"])("bounds a stalled %s and permits a fresh retry", async (stage) => {
    const policy = robots();
    if (stage === "robots") policy.assertAllowed.mockImplementationOnce(never);
    if (stage === "configuration") fixture.configure.mockImplementationOnce(never);
    if (stage === "cleanup") fixture.cleanup.mockImplementationOnce(never);
    const renderer = new IsolatedPageRenderer(policy as never);
    const outcome = renderer.render("https://example.com/article").then(
      () => "success", (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toBe("页面渲染超时，请检查网络后重试。");
    expect(fixture.windows.every((window) => window.isDestroyed())).toBe(true);
    if (stage === "configuration") expect(fixture.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    const retry = renderer.render("https://example.com/article");
    await vi.advanceTimersByTimeAsync(800);
    expect(await retry).toMatchObject({ html: "<p>Public document</p>" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the total budget across setup and separately verified redirects", async () => {
    const policy = robots();
    fixture.configure.mockImplementationOnce(() => pause(10_000));
    fixture.navigate.mockImplementationOnce(async (window) => {
      await pause(12_000);
      window.listeners.get("will-redirect")({ preventDefault() {} }, "https://publisher.example/article", false, true);
      throw new Error("ERR_ABORTED");
    }).mockImplementationOnce(never);
    const outcome = new IsolatedPageRenderer(policy as never).render("https://example.com/article").catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({ message: "页面渲染超时，请检查网络后重试。" });
    expect(policy.assertAllowed.mock.calls.map(([url]) => url)).toEqual(["https://example.com/article", "https://publisher.example/article"]);
    expect(fixture.windows[0].webContents.stop).toHaveBeenCalledOnce();
    expect(fixture.windows[0].isDestroyed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the original failure when teardown also fails", async () => {
    const failure = new Error("Navigation failed");
    fixture.navigate.mockRejectedValueOnce(failure);
    fixture.cleanup.mockRejectedValueOnce(new Error("Cleanup failed"));
    await expect(new IsolatedPageRenderer(robots() as never).render("https://example.com/article")).rejects.toBe(failure);
    expect(fixture.windows[0].isDestroyed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a failed request immediately even when cleanup never settles", async () => {
    const failure = new Error("Navigation failed");
    fixture.navigate.mockRejectedValueOnce(failure);
    fixture.cleanup.mockImplementationOnce(never);
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article").catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toBe(failure);
    expect(fixture.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller cancellation terminal while proxy initialization finishes late", async () => {
    let release!: () => void;
    fixture.configure.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const caller = new AbortController();
    const reason = new Error("User cancelled");
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article", { signal: caller.signal }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(reason);
    expect(await outcome).toBe(reason);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.windows).toHaveLength(0);
    expect(fixture.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("records sync backoff, retries before old setup settles and deduplicates after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reading-hub-public-lifetime-"));
  const databasePath = join(directory, "fixture.sqlite");
  let db = new ReadingDatabase(databasePath);
  const http = { getText: vi.fn() };
  const registry = new ConnectorRegistry();
  registry.register(new GenericConnector(http as never, new IsolatedPageRenderer(robots() as never)));
  let manager = new SyncManager(db, registry);
  const source = db.createSource({ url: "https://example.com/", title: "Fixture", kind: "generic", pollingEnabled: true });
  db.updateRule(source.id, { version: 1, selection: "manual", itemRootSelector: "article", rendererRequired: true });
  fixture.configure.mockImplementationOnce(never);
  // The older article intentionally comes first in the source document.
  fixture.capture.mockResolvedValue([1, 2].map((id) => `<article><h2><a href="/posts/${id}">A detailed technical article number ${id}</a></h2><time datetime="2026-08-0${id}"></time></article>`).join(""));
  try {
    const outcome = manager.syncSource(source.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ message: "页面渲染超时，请检查网络后重试。" });
    const failed = db.getSource(source.id)!;
    expect(failed).toMatchObject({ status: "error", failureCount: 1 });
    expect(failed.nextCheckAt).toBeGreaterThan(Date.now());
    const retry = manager.syncSource(source.id);
    await vi.advanceTimersByTimeAsync(800);
    expect(await retry).toMatchObject({ inserted: 2, source: { status: "active", failureCount: 0 } });
    expect(db.listEntries(source.id).map((entry) => entry.url)).toEqual(["https://example.com/posts/2", "https://example.com/posts/1"]);
    await manager.close(); db.close();
    db = new ReadingDatabase(databasePath);
    manager = new SyncManager(db, registry);
    const replay = manager.syncSource(source.id);
    await vi.advanceTimersByTimeAsync(800);
    expect(await replay).toMatchObject({ inserted: 0 });
    expect(db.listEntries(source.id)).toHaveLength(2);
    expect(http.getText).not.toHaveBeenCalled();
    expect(fixture.windows.every((window) => window.isDestroyed())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await manager.close(); db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


describe("public document response status", () => {
  it.each([false, true])("preserves HTTP failure or the available Feed summary (feed=%s)", async (feed) => {
    fixture.status = 404;
    const entry = { id: "fixture", title: "Fixture", url: "https://example.com/article", summary: "A summary explicitly supplied by the subscribed Feed." } as Entry;
    const http = { getText: vi.fn().mockRejectedValue(new Error("Static transport unavailable")) };
    const reader = new ArticleReader(http as never, new IsolatedPageRenderer(robots() as never));
    const outcome = reader.read(entry, { kind: feed ? "rss" : "generic", url: "https://example.com/feed.xml" } as Source).catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(await outcome).toMatchObject(feed
      ? { contentMode: "feed_summary", contentHtml: `<p>${entry.summary}</p>` }
      : { name: "RenderedPageHttpError", status: 404 });
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it("does not insert error-page cards and recovers on the next successful sync", async () => {
    const db = new ReadingDatabase(":memory:");
    const registry = new ConnectorRegistry();
    registry.register(new GenericConnector({ getText: vi.fn() } as never, new IsolatedPageRenderer(robots() as never)));
    const manager = new SyncManager(db, registry);
    const source = db.createSource({ url: "https://example.com/", title: "Fixture", kind: "generic", pollingEnabled: true });
    db.updateRule(source.id, { version: 1, selection: "manual", itemRootSelector: "article", rendererRequired: true });
    fixture.capture.mockResolvedValue('<article><h2><a href="/one">A detailed technical article title</a></h2><time datetime="2026-09-01"></time></article>');
    try {
      fixture.status = 503;
      const outcome = manager.syncSource(source.id).catch((error) => error);
      await vi.advanceTimersByTimeAsync(800);
      expect(await outcome).toMatchObject({ message: "页面请求失败（HTTP 503），无法读取正文。" });
      expect(db.listEntries(source.id)).toEqual([]);
      expect(db.getSource(source.id)).toMatchObject({ status: "error", failureCount: 1 });
      fixture.status = 200;
      const retry = manager.syncSource(source.id);
      await vi.advanceTimersByTimeAsync(800);
      expect(await retry).toMatchObject({ inserted: 1, source: { status: "active", failureCount: 0 } });
    } finally { await manager.close(); db.close(); }
  });

  it.each([401, 403, 404, 410, 429, 500, 503])("rejects HTTP %s before capturing error HTML", async (status) => {
    fixture.status = status;
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article").catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(await outcome).toMatchObject({ message: `页面请求失败（HTTP ${status}），无法读取正文。` });
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(fixture.windows[0].isDestroyed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([-1, undefined, 302])("does not assume a successful response for status %s", async (status) => {
    fixture.status = status;
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article").catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(await outcome).toBeInstanceOf(Error);
    expect(fixture.capture).not.toHaveBeenCalled();
  });
  it("rejects an error document that replaces the page during capture", async () => {
    fixture.capture.mockImplementationOnce(async () => {
      fixture.windows[0].listeners.get("did-navigate")({}, "https://example.com/article", 503, "Untrusted diagnostic");
      return "<article>Service unavailable</article>";
    });
    const outcome = new IsolatedPageRenderer(robots() as never).render("https://example.com/article").catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    expect(await outcome).toMatchObject({ message: "页面请求失败（HTTP 503），无法读取正文。" });
  });
});
