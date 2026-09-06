import { describe, expect, it, vi } from "vitest";
import { KeyedTaskQueue } from "../src/main/keyed-task-queue";

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe("keyed task queue", () => {
  it("preserves FIFO for one key without blocking independent resources", async () => {
    const queue = new KeyedTaskQueue();
    const gate = barrier();
    const started = barrier();
    const order: string[] = [];
    const first = queue.run("a", async () => { order.push("first"); started.release(); await gate.wait; return 1; });
    const second = queue.run("a", async () => { order.push("second"); return 2; });
    const third = queue.run("a", async () => { order.push("third"); return 3; });
    try {
      await started.wait;
      await expect(queue.run("b", async () => "independent")).resolves.toBe("independent");
      expect(order).toEqual(["first"]);
    } finally { gate.release(); }
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("releases cancelled waiters promptly while keeping later arrivals behind active work", async () => {
    const queue = new KeyedTaskQueue();
    const gate = barrier();
    const started = barrier();
    const active = queue.run("a", async () => { started.release(); await gate.wait; });
    const abandoned = vi.fn(async () => undefined);
    const successor = vi.fn(async () => undefined);
    const controller = new AbortController();
    let next: Promise<void> | undefined;
    try {
      await started.wait;
      const cancelled = queue.run("a", abandoned, controller.signal);
      controller.abort(new Error("cancel waiter"));
      await expect(cancelled).rejects.toThrow("cancel waiter");
      next = queue.run("a", successor);
      await queue.run("b", async () => undefined);
      expect(abandoned).not.toHaveBeenCalled();
      expect(successor).not.toHaveBeenCalled();
    } finally { gate.release(); await active; await next; }
    expect(successor).toHaveBeenCalledTimes(1);
  });

  it("does not release a running task's slot merely because its signal was aborted", async () => {
    const queue = new KeyedTaskQueue();
    const gate = barrier();
    const started = barrier();
    const controller = new AbortController();
    const active = queue.run("a", async () => { started.release(); await gate.wait; return "write finished"; }, controller.signal);
    const successor = vi.fn(async () => undefined);
    let next: Promise<void> | undefined;
    try {
      await started.wait;
      controller.abort();
      next = queue.run("a", successor);
      await queue.run("b", async () => undefined);
      expect(successor).not.toHaveBeenCalled();
    } finally { gate.release(); }
    await expect(active).resolves.toBe("write finished");
    await next;
    expect(successor).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("releases a failed task and permits later reuse (synchronous: %s)", async (synchronous) => {
    const queue = new KeyedTaskQueue();
    const failure = new Error("task failed");
    const first = queue.run("a", () => { if (synchronous) throw failure; return Promise.reject(failure); });
    const next = queue.run("a", async () => "next");
    await expect(first).rejects.toBe(failure);
    await expect(next).resolves.toBe("next");
    await expect(queue.run("a", async () => "reused")).resolves.toBe("reused");
  });

  it("never starts work submitted with an already aborted signal", async () => {
    const queue = new KeyedTaskQueue();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const task = vi.fn(async () => undefined);
    await expect(queue.run("a", task, controller.signal)).rejects.toThrow("already cancelled");
    expect(task).not.toHaveBeenCalled();
    await expect(queue.run("a", async () => "available")).resolves.toBe("available");
  });
});
