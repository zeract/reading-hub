import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>(), fetch: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { removeHandler: (name: string) => mocks.handlers.delete(name), handle: (name: string, callback: any) => mocks.handlers.set(name, callback) }, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock("../src/main/network", () => ({ chromiumFetch: mocks.fetch }));
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { PublicHttpClient } from "../src/main/http";
import type { ApplicationServices } from "../src/main/app-services";
class Sender extends EventEmitter {
  constructor(readonly id: number) { super(); }
  isDestroyed() { return false; }
}
const invoke = async (sender: Sender, channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args);
const start = (sender: Sender, requestId: unknown, suffix = "") => invoke(sender, IPC_CHANNELS.entry.loadImage, "entry", `https://example.com/image.png${suffix}`, requestId);
const cancel = (sender: Sender, requestId: unknown) => invoke(sender, IPC_CHANNELS.entry.cancelImage, requestId);
function setup() {
  return registerIpcHandlers({
    database: { getEntry: () => ({ id: "entry", sourceId: "source", url: "https://example.com/article" }) },
    http: new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never)
  } as unknown as ApplicationServices);
}
beforeEach(() => { mocks.handlers.clear(); mocks.fetch.mockReset(); });

describe("image cancellation IPC boundary", () => {
  it("does not cancel another window's shared image even when its request id matches", async () => {
    const drain = setup(), one = new Sender(1), two = new Sender(2);
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const first = start(one, "same").catch((error) => error), second = start(two, "same");
    try {
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
      await cancel(one, "same"); expect((await first).message).toContain("已取消");
      expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(false);
      finish(new Response("fixture", { headers: { "content-type": "image/png" } }));
      await expect(second).resolves.toContain("data:image/png;base64,");
      expect(one.listenerCount("destroyed")).toBe(0); expect(two.listenerCount("destroyed")).toBe(0);
    } finally { await drain(); }
  });

  it("cancels queued IPC images without starting their downloads", async () => {
    const drain = setup(), owner = new Sender(1);
    mocks.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const active = Array.from({ length: 4 }, (_, i) => start(owner, `active-${i}`, `?${i}`).catch((error) => error));
    const queued = start(owner, "queued", "?queued").catch((error) => error);
    try {
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(4));
      await cancel(owner, "queued"); expect((await queued).message).toContain("已取消");
      expect(mocks.fetch).toHaveBeenCalledTimes(4);
    } finally { await drain(); await Promise.all(active); }
  });

  it("rejects a duplicate active id without changing the first request", async () => {
    const drain = setup(), owner = new Sender(1);
    mocks.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const first = start(owner, "same").catch((error) => error);
    try {
      await expect(start(owner, "same", "?different")).rejects.toThrow("已在使用");
      await cancel(owner, "same"); expect((await first).message).toContain("已取消");
    } finally { await drain(); }
  });

  it.each([undefined, "", "x".repeat(161), {}])("rejects invalid request ids before network work: %j", async (requestId) => {
    const drain = setup(), owner = new Sender(1);
    try {
      await expect(start(owner, requestId)).rejects.toThrow("标识无效");
      await expect(cancel(owner, requestId)).rejects.toThrow("标识无效");
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally { await drain(); }
  });
});
