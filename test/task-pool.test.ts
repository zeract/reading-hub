import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { TaskPool, TaskPoolFullError } from "../src/main/task-pool";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bounded task admission", () => {
  it("closes queued and future admission without revoking active cleanup leases", async () => {
    const pool = new TaskPool(1, 2);
    const release = await pool.acquire();
    const controller = new AbortController();
    const failure = new Error("bridge closed");
    const second = expect(pool.acquire({ signal: controller.signal })).rejects.toBe(failure);
    const third = expect(pool.run(async () => "must not run")).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    pool.close(failure);
    pool.close(new Error("later close"));
    expect(pool.activeCount).toBe(1);
    expect(pool.queuedCount).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    await Promise.all([second, third]);
    await expect(pool.acquire()).rejects.toBe(failure);
    release(); release();
    expect(pool.activeCount).toBe(0);
    await expect(pool.acquire()).rejects.toBe(failure);
  });

  it("does not release a handed-off lease through the previous owner's repeated cleanup", async () => {
    const pool = new TaskPool(1);
    const releaseFirst = await pool.acquire();
    const second = pool.acquire();
    releaseFirst();
    releaseFirst();
    const third = pool.acquire();
    const releaseSecond = await second;
    expect(pool.activeCount).toBe(1);
    expect(pool.queuedCount).toBe(1);
    releaseSecond();
    const releaseThird = await third;
    expect(pool.activeCount).toBe(1);
    releaseThird();
    expect(pool.activeCount).toBe(0);
  });

  it("leaves a reserved lease with its owner when cancellation races the promise continuation", async () => {
    const pool = new TaskPool(1);
    const releaseFirst = await pool.acquire();
    const controller = new AbortController();
    const second = pool.acquire({ signal: controller.signal });
    releaseFirst();
    controller.abort();
    const releaseSecond = await second;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(pool.activeCount).toBe(1);
    releaseSecond();
    expect(pool.activeCount).toBe(0);
  });

  it("uses caller-specific cancellation errors before admission and rejects invalid limits", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private native details"));
    const failure = new Error("AI 请求已取消。");
    const pool = new TaskPool(1, 0);
    await expect(pool.acquire({ signal: controller.signal, abortError: () => failure })).rejects.toBe(failure);
    expect(pool.activeCount).toBe(0);
    for (const capacity of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TaskPool(capacity)).toThrow(RangeError);
    }
    for (const maxQueued of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TaskPool(1, maxQueued)).toThrow(RangeError);
    }
  });

  it("atomically hands released App Server capacity to FIFO waiters", async () => {
    const semaphore = new TaskPool(2);
    let maxObservedActive = 0;
    const observe = () => { maxObservedActive = Math.max(maxObservedActive, semaphore.activeCount); };

    const releaseFirst = await semaphore.acquire();
    observe();
    const releaseSecond = await semaphore.acquire();
    observe();
    const third = semaphore.acquire();
    const fourth = semaphore.acquire();
    const fifth = semaphore.acquire();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(3);

    // While the third caller is being woken, a fresh fifth caller is already
    // queued. The released slot must remain reserved for the third caller.
    releaseFirst();
    observe();
    expect(semaphore.activeCount).toBe(2);
    const releaseThird = await third;
    observe();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(2);

    releaseSecond();
    observe();
    const releaseFourth = await fourth;
    observe();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(1);

    releaseThird();
    observe();
    const releaseFifth = await fifth;
    observe();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(0);

    releaseFourth();
    releaseFifth();
    observe();
    expect(maxObservedActive).toBeLessThanOrEqual(2);
    expect(semaphore.activeCount).toBe(0);
  });

  it("removes a cancelled queued caller without consuming a later slot", async () => {
    const semaphore = new TaskPool(1);
    const releaseFirst = await semaphore.acquire();
    const controller = new AbortController();
    const cancelled = semaphore.acquire({ signal: controller.signal, abortError: () => new Error("AI 请求已取消。") });
    expect(semaphore.queuedCount).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toThrow("AI 请求已取消。");
    expect(semaphore.queuedCount).toBe(0);

    releaseFirst();
    const releaseNext = await semaphore.acquire();
    expect(semaphore.activeCount).toBe(1);
    releaseNext();
  });


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
