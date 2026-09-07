import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  return { handlers, ipcMain: { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, callback: any) => handlers.set(name, callback) }, BrowserWindow: {}, dialog: {}, shell: {} };
});
vi.mock("electron", () => electron);
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
  const invoke = (channel: string) => electron.handlers.get(channel)!({ sender }, "entry", "https://example.com/alternate", "fixture-image-request");
  return { sender, invoke, drain, viewer, articles, http };
}
beforeEach(() => electron.handlers.clear());
describe("reader request lifetime", () => {
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
