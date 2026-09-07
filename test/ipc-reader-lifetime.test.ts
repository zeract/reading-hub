import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  return { handlers, ipcMain: { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, callback: any) => handlers.set(name, callback) }, BrowserWindow: {}, dialog: {}, shell: {} };
});
vi.mock("electron", () => electron);
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { ArticleReader } from "../src/main/article-reader";
import { PublicHttpClient } from "../src/main/http";
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { RobotsDisallowedError } from "../src/main/robots";
import type { ApplicationServices } from "../src/main/app-services";
class Sender extends EventEmitter {
  id = 1;
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
function fixture(read: (...args: any[]) => Promise<unknown>) {
  const entry = { id: "entry", sourceId: "source", url: "https://example.com/post", title: "Fixture" };
  const source = { id: "source", kind: "rss", url: "https://example.com/feed" };
  const database = { getEntry: () => entry, getSource: () => source };
  const articles = { read: vi.fn(read), readLanguageVariant: vi.fn(read) };
  const http = { getImageDataUrl: vi.fn(read) };
  const viewer = { open: vi.fn(async () => undefined) };
  const drain = registerIpcHandlers({ database, articles, http, inAppArticleViewer: viewer } as unknown as ApplicationServices);
  const sender = new Sender();
  const invoke = (channel: string) => channel === IPC_CHANNELS.entry.readContent
    ? electron.handlers.get(channel)!({ sender }, "entry", "fixture-read-request")
    : electron.handlers.get(channel)!({ sender }, "entry", "https://example.com/alternate", "fixture-image-request");
  return { sender, invoke, drain, viewer, articles, http };
}
beforeEach(() => { electron.handlers.clear(); network.fetch.mockReset(); });
describe("reader request lifetime", () => {
  it("propagates explicit cancellation through the actual reader and HTTP header wait", async () => {
    const http = new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
    const reader = new ArticleReader(http, { render: vi.fn() });
    const run = fixture((entry, source, options) => reader.read(entry, source, options));
    let finish!: (response: Response) => void;
    network.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const outcome = run.invoke(IPC_CHANNELS.entry.readContent).catch((error) => error);
    try {
      await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1));
      await electron.handlers.get(IPC_CHANNELS.entry.cancelRead)!({ sender: run.sender }, "fixture-read-request");
      expect((await outcome).message).toContain("已取消");
      expect(network.fetch.mock.calls[0][1].signal.aborted).toBe(true);
      const cancel = vi.fn();
      finish(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(run.viewer.open).not.toHaveBeenCalled();
    } finally { await run.drain(); }
  });

  it("does not open a late robots fallback after an explicit read cancellation", async () => {
    let fail!: (error: Error) => void;
    const run = fixture(() => new Promise((_resolve, reject) => { fail = reject; }));
    const outcome = run.invoke(IPC_CHANNELS.entry.readContent).catch((error) => error);
    await electron.handlers.get(IPC_CHANNELS.entry.cancelRead)!({ sender: run.sender }, "fixture-read-request");
    fail(new RobotsDisallowedError());
    expect((await outcome).message).toContain("已取消");
    expect(run.viewer.open).not.toHaveBeenCalled();
    await run.drain();
  });

  it.each([IPC_CHANNELS.entry.readContent, IPC_CHANNELS.entry.readLanguageVariant])("scopes cancellation of %s to its owner and passes the signal downstream", async (channel) => {
    const signals: AbortSignal[] = [];
    const run = fixture(async (...args) => {
      const signal = args.at(-1).signal as AbortSignal; signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const other = new Sender(); other.id = 2;
    const args = channel === IPC_CHANNELS.entry.readContent ? ["entry", "same"] : ["entry", "https://example.com/alternate", "same"];
    const first = electron.handlers.get(channel)!({ sender: run.sender }, ...args).catch((error) => error);
    const second = electron.handlers.get(channel)!({ sender: other }, ...args).catch((error) => error);
    await electron.handlers.get(IPC_CHANNELS.entry.cancelRead)!({ sender: run.sender }, "same");
    expect((await first).message).toContain("已取消");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    await run.drain(); await second;
  });

  it("cannot cancel an image by submitting the same opaque id to read cancellation", async () => {
    let signal!: AbortSignal;
    const run = fixture(async (...args) => {
      signal = args.at(-1).signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const pending = run.invoke(IPC_CHANNELS.entry.loadImage).catch((error) => error);
    await electron.handlers.get(IPC_CHANNELS.entry.cancelRead)!({ sender: run.sender }, "fixture-image-request");
    expect(signal.aborted).toBe(false);
    await run.drain(); await pending;
  });

  it("does not open a late robots fallback after its window is destroyed", async () => {
    let finish!: () => void;
    const run = fixture(async () => new Promise((_resolve, reject) => { finish = () => reject(new RobotsDisallowedError()); }));
    const pending = run.invoke(IPC_CHANNELS.entry.readContent);
    const outcome = pending.catch((error) => error);
    run.sender.destroy(); finish();
    expect((await outcome).message).toContain("窗口已关闭");
    expect(run.viewer.open).not.toHaveBeenCalled();
    await run.drain();
  });

  it.each([IPC_CHANNELS.entry.readContent, IPC_CHANNELS.entry.readLanguageVariant, IPC_CHANNELS.entry.loadImage, IPC_CHANNELS.source.loadIcon])("passes a window cancellation signal to %s", async (channel) => {
    let signal: unknown;
    const run = fixture(async (...args) => { signal = args.at(-1)?.signal; return undefined; });
    try { await run.invoke(channel); expect(signal).toBeInstanceOf(AbortSignal); }
    finally { await run.drain(); }
  });

  it.each([IPC_CHANNELS.entry.readContent, IPC_CHANNELS.entry.readLanguageVariant, IPC_CHANNELS.entry.loadImage, IPC_CHANNELS.source.loadIcon])("aborts pending %s work when IPC shuts down", async (channel) => {
    let signal!: AbortSignal;
    const run = fixture(async (...args) => {
      signal = args.at(-1).signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const outcome = run.invoke(channel).catch((error) => error);
    await run.drain();
    expect(signal.aborted).toBe(true);
    expect(await outcome).toBe(signal.reason);
    expect(run.sender.listenerCount("destroyed")).toBe(0);
  });

  it("rejects a late successful read after the owner closes", async () => {
    let finish!: (value: unknown) => void;
    const run = fixture(async () => new Promise((resolve) => { finish = resolve; }));
    const outcome = run.invoke(IPC_CHANNELS.entry.readContent).catch((error) => error);
    run.sender.destroy();
    finish({ title: "Late article" });
    expect((await outcome).message).toContain("窗口已关闭");
    await run.drain();
  });

  it("retains a live robots fallback with the owning request signal", async () => {
    let signal!: AbortSignal;
    const run = fixture(async (...args) => { signal = args.at(-1).signal; throw new RobotsDisallowedError(); });
    expect(await run.invoke(IPC_CHANNELS.entry.readContent)).toEqual({ kind: "embedded" });
    expect(run.viewer.open).toHaveBeenCalledWith("https://example.com/post", "Fixture", signal);
    expect(signal.aborted).toBe(false);
    await run.drain();
  });

  it("keeps ordinary favicon failures optional", async () => {
    const run = fixture(async () => { throw new Error("Image unavailable"); });
    expect(await run.invoke(IPC_CHANNELS.source.loadIcon)).toBeUndefined();
    await run.drain();
  });

  it("scopes explicit original-page requests and refuses a destroyed owner", async () => {
    const run = fixture(async () => undefined);
    await run.invoke(IPC_CHANNELS.entry.openEmbedded);
    expect(run.viewer.open).toHaveBeenCalledWith("https://example.com/post", "Fixture", expect.any(AbortSignal));
    run.sender.destroy();
    await expect(run.invoke(IPC_CHANNELS.entry.openEmbedded)).rejects.toThrow("窗口已关闭");
    expect(run.viewer.open).toHaveBeenCalledTimes(1);
    await run.drain();
  });
});
