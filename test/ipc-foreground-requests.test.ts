import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  return { handlers, ipcMain: { removeHandler: (name: string) => handlers.delete(name), handle: (name: string, callback: any) => handlers.set(name, callback) }, BrowserWindow: {}, dialog: {}, shell: {} };
});
vi.mock("electron", () => electron);
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { SourceService } from "../src/main/source-service";
import { SourceProbe } from "../src/main/source-probe";
import type { ApplicationServices } from "../src/main/app-services";
class Sender extends EventEmitter {
  id = 1;
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
function setup(authorize: (client: string, signal: AbortSignal) => Promise<unknown>, discover = async (_query: string, _context: { signal: AbortSignal }): Promise<unknown[]> => [], sourceOverrides: Partial<Pick<SourceService, "preview" | "calibrate">> = {}) {
  const x = { authorizeWithClientId: vi.fn(authorize) };
  const sources = { ensureXSource: vi.fn(() => ({ id: "fixture-source" })), ...sourceOverrides };
  const sync = { syncSource: vi.fn(async () => ({ inserted: 0 })) };
  const drain = registerIpcHandlers({ x, sources, sync, academic: { discover } } as unknown as ApplicationServices);
  const connect = (sender: Sender) => electron.handlers.get(IPC_CHANNELS.x.connect)!({ sender }, "fixture-client");
  return { x, sources, sync, drain, connect };
}
beforeEach(() => electron.handlers.clear());
describe("IPC foreground request lifetime", () => {
  it("cancels authorization before draining IPC on quit", async () => {
    const run = setup(async (_client, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const sender = new Sender();
    const pending = run.connect(sender);
    const rejected = expect(pending).rejects.toThrow("应用正在退出");
    await run.drain();
    await rejected;
    expect(run.sources.ensureXSource).not.toHaveBeenCalled();
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("does not create a source from a late authorization result after its window is destroyed", async () => {
    let finish!: () => void;
    const run = setup(async () => new Promise((resolve) => { finish = () => resolve({ id: "fixture-account" }); }));
    const sender = new Sender();
    const pending = run.connect(sender);
    const rejected = expect(pending).rejects.toThrow("窗口已关闭");
    sender.destroy();
    finish();
    await rejected;
    expect(run.x.authorizeWithClientId.mock.calls[0][1].aborted).toBe(true);
    expect(run.sources.ensureXSource).not.toHaveBeenCalled();
    await run.drain();
  });

  it("only cancels authorization owned by the destroyed window", async () => {
    const run = setup(async (_client, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const first = new Sender();
    const second = new Sender(); second.id = 2;
    const firstPending = run.connect(first).catch((error) => error);
    const secondPending = run.connect(second).catch((error) => error);
    first.destroy();
    expect((await firstPending).message).toContain("窗口已关闭");
    expect(run.x.authorizeWithClientId.mock.calls[1][1].aborted).toBe(false);
    await run.drain();
    expect((await secondPending).message).toContain("应用正在退出");
  });

  it("does not authorize an already-destroyed sender", async () => {
    const run = setup(async () => ({ id: "fixture-account" }));
    const sender = new Sender(); sender.destroy();
    await expect(run.connect(sender)).rejects.toThrow("窗口已关闭");
    expect(run.x.authorizeWithClientId).not.toHaveBeenCalled();
    expect(sender.listenerCount("destroyed")).toBe(0);
    await run.drain();
  });

  it("detaches the lifetime hook after a successful authorization and sync", async () => {
    const run = setup(async () => ({ id: "fixture-account" }));
    const sender = new Sender();
    await expect(run.connect(sender)).resolves.toEqual({ inserted: 0 });
    const signal = run.x.authorizeWithClientId.mock.calls[0][1];
    sender.destroy();
    await run.drain();
    expect(signal.aborted).toBe(false);
    expect(run.sources.ensureXSource).toHaveBeenCalledTimes(1);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("aborts both academic provider requests before draining IPC on quit", async () => {
    const { AcademicAuthorConnector } = await import("../src/main/academic");
    const signals: AbortSignal[] = [];
    const connector = new AcademicAuthorConnector(async (_url, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => undefined);
    });
    const run = setup(async () => ({}), connector.discover.bind(connector));
    const sender = new Sender();
    const pending = electron.handlers.get(IPC_CHANNELS.academic.search)!({ sender }, "Chen");
    const rejected = expect(pending).rejects.toThrow("应用正在退出");
    expect(signals).toHaveLength(2);
    await run.drain();
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("rejects a late academic result after its owner window closes", async () => {
    let finish!: (value: unknown[]) => void;
    const run = setup(async () => ({}), async () => new Promise((resolve) => { finish = resolve; }));
    const sender = new Sender();
    const pending = electron.handlers.get(IPC_CHANNELS.academic.search)!({ sender }, "Chen");
    const rejected = expect(pending).rejects.toThrow("窗口已关闭");
    sender.destroy();
    finish([{ title: "Fixture author" }]);
    await rejected;
    expect(sender.listenerCount("destroyed")).toBe(0);
    await run.drain();
  });


  it.each(["preview", "calibration"] as const)("cancels the %s transport before IPC shutdown finishes", async (kind) => {
    let requestSignal: AbortSignal | undefined;
    const http = { getText: vi.fn(async (_url: string, _cached, options) => {
      requestSignal = options?.signal;
      return new Promise((_resolve, reject) => requestSignal?.addEventListener("abort", () => reject(requestSignal!.reason), { once: true }));
    }) };
    const service = new SourceService({ getSource: () => ({ kind: "generic", url: "https://example.com/" }) } as never, new SourceProbe(http as never), {} as never, {} as never);
    const run = setup(async () => ({}), async () => [], { preview: service.preview.bind(service), calibrate: service.calibrate.bind(service) });
    const sender = new Sender();
    const channel = kind === "preview" ? IPC_CHANNELS.source.preview : IPC_CHANNELS.source.calibration;
    const pending = electron.handlers.get(channel)!({ sender }, kind === "preview" ? "https://example.com/" : "fixture-source");
    const rejected = expect(pending).rejects.toThrow("应用正在退出");
    expect(requestSignal).toBeDefined();
    await run.drain();
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

});
