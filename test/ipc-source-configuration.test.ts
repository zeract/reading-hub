import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, callback: (...args: any[]) => any) => handlers.set(channel, callback),
  removeHandler: (channel: string) => handlers.delete(channel)
}, BrowserWindow: {}, dialog: {}, shell: {} }));
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";

describe("source calibration IPC boundary", () => {
  it("routes validated rule writes through the service that invalidates old synchronization", async () => {
    const sources = { updateRule: vi.fn() };
    const database = { updateRule: vi.fn() };
    const drain = registerIpcHandlers({ sources, database } as never);
    const handler = handlers.get(IPC_CHANNELS.source.updateRule)!;
    try {
      await handler({ sender: {} }, "fixture-source", { version: 1, titleSelector: "a", unknownField: "ignored" });
      expect(sources.updateRule).toHaveBeenCalledExactlyOnceWith("fixture-source", { version: 1, titleSelector: "a" });
      expect(database.updateRule).not.toHaveBeenCalled();
      expect(() => handler({ sender: {} }, "fixture-source", { version: 99 })).toThrow("提取规则无效");
      expect(sources.updateRule).toHaveBeenCalledTimes(1);
    } finally { await drain(); }
  });
});
