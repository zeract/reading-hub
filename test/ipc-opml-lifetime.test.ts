import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  select: vi.fn(),
  text: "<opml><body/></opml>",
  declaredSize: 20,
  afterRead: undefined as (() => void) | undefined,
  close: vi.fn(async () => undefined)
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: any) => mocks.handlers.set(channel, listener),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: mocks.select }, shell: {}
}));
vi.mock("node:fs/promises", () => ({
  open: async () => {
    let position = 0;
    return {
      stat: async () => ({ isFile: () => true, size: mocks.declaredSize }),
      read: async (buffer: Uint8Array, offset: number, length: number) => {
        const bytes = new TextEncoder().encode(mocks.text);
        const part = bytes.subarray(position, position + length);
        buffer.set(part, offset); position += part.length;
        mocks.afterRead?.();
        return { bytesRead: part.length, buffer };
      },
      close: mocks.close
    };
  }
}));
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import type { ApplicationServices } from "../src/main/app-services";
import { IPC_CHANNELS } from "../src/shared/ipc";

class Sender extends EventEmitter {
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
function fixture() {
  const importOpml = vi.fn(() => ({ imported: 1, existing: 0, skipped: 0 }));
  const drain = registerIpcHandlers({ sources: { importOpml } } as unknown as ApplicationServices);
  const sender = new Sender();
  return { importOpml, drain, sender, invoke: () => mocks.handlers.get(IPC_CHANNELS.source.importOpml)!({ sender }) };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear();
  mocks.text = "<opml><body/></opml>"; mocks.declaredSize = 20;
  mocks.afterRead = undefined;
  mocks.select.mockResolvedValue({ canceled: false, filePaths: ["/fixture/subscriptions.opml"] });
});

describe("OPML import lifetime", () => {
  it("does not import a selection returned after its owner has closed", async () => {
    let selected!: (value: unknown) => void;
    mocks.select.mockImplementationOnce(() => new Promise((resolve) => { selected = resolve; }));
    const run = fixture();
    const pending = run.invoke();
    const outcome = pending.catch((error) => error);
    run.sender.destroy();
    selected({ canceled: false, filePaths: ["/fixture/subscriptions.opml"] });
    expect((await outcome).message).toContain("窗口已关闭");
    expect(run.importOpml).not.toHaveBeenCalled();
    await run.drain();
  });

  it("enforces the byte limit if the file grew after the metadata check", async () => {
    mocks.text = "x".repeat(2_000_001);
    mocks.declaredSize = 20;
    const run = fixture();
    try {
      await expect(run.invoke()).rejects.toThrow("2 MB");
      expect(run.importOpml).not.toHaveBeenCalled();
    } finally { await run.drain(); }
  });

  it("drains shutdown without waiting for a native dialog's late result", async () => {
    let selected!: (value: unknown) => void;
    mocks.select.mockImplementationOnce(() => new Promise((resolve) => { selected = resolve; }));
    const run = fixture();
    const outcome = run.invoke().catch((error) => error);
    await run.drain();
    expect((await outcome).message).toContain("应用正在退出");
    selected({ canceled: false, filePaths: ["/fixture/subscriptions.opml"] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run.importOpml).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("closes the file and does not commit an import cancelled during reading", async () => {
    const run = fixture();
    mocks.afterRead = () => run.sender.destroy();
    await expect(run.invoke()).rejects.toThrow("窗口已关闭");
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(run.importOpml).not.toHaveBeenCalled();
    await run.drain();
  });

  it("preserves ordinary dialog cancellation and successful import", async () => {
    const run = fixture();
    mocks.select.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await run.invoke()).toEqual({ cancelled: true, imported: 0, existing: 0, skipped: 0 });
    expect(run.importOpml).not.toHaveBeenCalled();
    expect(await run.invoke()).toEqual({ cancelled: false, imported: 1, existing: 0, skipped: 0 });
    expect(run.importOpml).toHaveBeenCalledWith(mocks.text);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(run.sender.listenerCount("destroyed")).toBe(0);
    await run.drain();
  });
});
