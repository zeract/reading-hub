import { describe, expect, it, vi } from "vitest";
import { TaskPool, TaskPoolFullError } from "../src/main/task-pool";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bounded task admission", () => {
  it("reserves capacity synchronously and rejects overflow without running it", async () => {
    const pool = new TaskPool(1, 1), gate = deferred();
    const first = pool.run(() => gate.promise);
    const queued = vi.fn(async () => "queued");
    const second = pool.run(queued);
    const excess = vi.fn(async () => "excess");
    await expect(pool.run(excess)).rejects.toBeInstanceOf(TaskPoolFullError);
    expect(queued).not.toHaveBeenCalled(); expect(excess).not.toHaveBeenCalled();
    gate.resolve(); await first;
    expect(await second).toBe("queued");
  });

  it("keeps FIFO order when a new arrival races with a released slot", async () => {
    const pool = new TaskPool(1, 3), gate = deferred();
    const order: number[] = [];
    const first = pool.run(() => gate.promise);
    const second = pool.run(async () => { order.push(2); });
    const third = pool.run(async () => { order.push(3); });
    gate.resolve(); await first;
    const fourth = pool.run(async () => { order.push(4); });
    await Promise.all([second, third, fourth]);
    expect(order).toEqual([2, 3, 4]);
  });

  it("removes a cancelled queued task immediately so a replacement can enter", async () => {
    const pool = new TaskPool(1, 1), gate = deferred(), controller = new AbortController();
    const first = pool.run(() => gate.promise);
    const cancelled = vi.fn(async () => "wrong");
    const second = expect(pool.run(cancelled, controller.signal)).rejects.toThrow("leave queue");
    controller.abort(new Error("leave queue"));
    const replacement = pool.run(async () => "replacement");
    await second; gate.resolve(); await first;
    expect(await replacement).toBe("replacement");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("keeps a running operation's slot until its cleanup finishes after cancellation", async () => {
    const pool = new TaskPool(1, 1), gate = deferred(), controller = new AbortController();
    const operation = vi.fn(() => gate.promise);
    const first = pool.run(operation, controller.signal);
    await vi.waitFor(() => expect(operation).toHaveBeenCalled());
    const queued = vi.fn(async () => "next");
    const second = pool.run(queued);
    controller.abort();
    await Promise.resolve(); expect(queued).not.toHaveBeenCalled();
    gate.resolve(); await first;
    expect(await second).toBe("next");
  });

  it("does not start a caller cancelled after reservation but before execution", async () => {
    const pool = new TaskPool(1, 1), controller = new AbortController();
    const operation = vi.fn(async () => "wrong");
    const first = expect(pool.run(operation, controller.signal)).rejects.toThrow("before execution");
    controller.abort(new Error("before execution"));
    const second = pool.run(async () => "next");
    await first; expect(await second).toBe("next");
    expect(operation).not.toHaveBeenCalled();
  });

  it("frees capacity on synchronous and asynchronous failures", async () => {
    const pool = new TaskPool(1, 2);
    const sync = expect(pool.run(() => { throw new Error("sync"); })).rejects.toThrow("sync");
    const async = expect(pool.run(async () => { throw new Error("async"); })).rejects.toThrow("async");
    const third = pool.run(async () => "done");
    await Promise.all([sync, async]); expect(await third).toBe("done");
  });

  it.each([false, true])("releases queued abort listeners (cancel=%s)", async (cancel) => {
    const pool = new TaskPool(1, 1), gate = deferred(), controller = new AbortController();
    const first = pool.run(() => gate.promise);
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const second = pool.run(async () => "second", controller.signal).catch(() => "cancelled");
    if (cancel) controller.abort();
    gate.resolve(); await Promise.all([first, second]);
    for (const [type, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(type, listener);
  });

  it("supports no waiting capacity and gives pre-cancellation priority over saturation", async () => {
    const pool = new TaskPool(1, 0), gate = deferred(), controller = new AbortController();
    const first = pool.run(() => gate.promise);
    const blocked = vi.fn(async () => "blocked");
    controller.abort(new Error("already cancelled"));
    await expect(pool.run(blocked, controller.signal)).rejects.toThrow("already cancelled");
    await expect(pool.run(blocked)).rejects.toBeInstanceOf(TaskPoolFullError);
    gate.resolve(); await first;
    expect(blocked).not.toHaveBeenCalled();
  });
});
