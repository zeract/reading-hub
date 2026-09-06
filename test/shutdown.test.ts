import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../src/main/shutdown";

describe("application shutdown", () => {
  it("prevents repeated quits until asynchronous cleanup has completed exactly once", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(() => pending);
    const quit = vi.fn();
    const fail = vi.fn();
    const onQuit = createShutdownHandler(close, quit, fail);
    const event = { preventDefault: vi.fn() };
    onQuit(event);
    await Promise.resolve();
    onQuit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    onQuit(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
  });

  it("handles cleanup failures without claiming a successful quit", async () => {
    const quit = vi.fn();
    const fail = vi.fn();
    const onQuit = createShutdownHandler(async () => { throw new Error("close failed"); }, quit, fail);
    onQuit({ preventDefault() {} });
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
    expect(quit).not.toHaveBeenCalled();
  });
});
