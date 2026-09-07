import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WindowRequestScope } from "../src/main/window-request-scope";
class Owner extends EventEmitter {
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const untilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

describe("window request scope", () => {
  it("cancels only the named operation of the exact owner", async () => {
    const scope = new WindowRequestScope(), one = new Owner(), two = new Owner();
    const signals: AbortSignal[] = [];
    const work = (signal: AbortSignal) => { signals.push(signal); return untilAborted(signal); };
    const first = scope.run(one, work, "image:one").catch((error) => error);
    const unnamed = scope.run(one, work).catch((error) => error);
    const other = scope.run(two, work, "image:one").catch((error) => error);
    scope.cancel(one, "image:one");
    expect((await first).message).toContain("已取消");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
    scope.close(); await Promise.all([unnamed, other]);
  });

  it("rejects duplicate active ids without replacing the original operation", async () => {
    const scope = new WindowRequestScope(), owner = new Owner();
    const original = scope.run(owner, untilAborted, "same").catch((error) => error);
    const duplicate = vi.fn(async () => "duplicate");
    await expect(scope.run(owner, duplicate, "same")).rejects.toThrow("已在使用");
    expect(duplicate).not.toHaveBeenCalled();
    scope.cancel(owner, "same"); await original;
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("keeps a reused id cancellable after the old operation cleans up late", async () => {
    const scope = new WindowRequestScope(), owner = new Owner(), gate = deferred<string>();
    const old = scope.run(owner, () => gate.promise, "same").catch((error) => error);
    scope.cancel(owner, "same");
    const next = scope.run(owner, untilAborted, "same").catch((error) => error);
    gate.resolve("late"); expect((await old).message).toContain("已取消");
    scope.cancel(owner, "same"); expect((await next).message).toContain("已取消");
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("does not retain unknown or completed cancellation ids", async () => {
    const scope = new WindowRequestScope(), owner = new Owner();
    scope.cancel(owner, "future");
    await expect(scope.run(owner, async () => "done", "future")).resolves.toBe("done");
    scope.cancel(owner, "future");
    await expect(scope.run(owner, async () => "again", "future")).resolves.toBe("again");
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("shares one destruction listener across concurrent requests and cleans it up", async () => {
    const scope = new WindowRequestScope();
    const owner = new Owner();
    const gate = deferred<number>();
    const requests = Array.from({ length: 20 }, () => scope.run(owner, () => gate.promise));
    expect(owner.listenerCount("destroyed")).toBe(1);
    gate.resolve(42);
    expect(await Promise.all(requests)).toEqual(Array(20).fill(42));
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("only aborts requests owned by a destroyed window", async () => {
    const scope = new WindowRequestScope();
    const first = new Owner();
    const second = new Owner();
    let otherSignal!: AbortSignal;
    const firstPending = scope.run(first, untilAborted).catch((error) => error);
    const secondPending = scope.run(second, (signal) => { otherSignal = signal; return untilAborted(signal); }).catch((error) => error);
    first.destroy();
    expect((await firstPending).message).toContain("窗口已关闭");
    expect(otherSignal.aborted).toBe(false);
    scope.close();
    expect((await secondPending).message).toContain("应用正在退出");
    expect(second.listenerCount("destroyed")).toBe(0);
  });

  it("waits for an active operation to settle instead of abandoning its durable work", async () => {
    const scope = new WindowRequestScope();
    const owner = new Owner();
    const gate = deferred<string>();
    let settled = false;
    const pending = scope.run(owner, () => gate.promise).catch((error) => { settled = true; return error; });
    scope.close();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve("saved");
    expect((await pending).message).toContain("应用正在退出");
  });

  it("rejects new work after close or owner destruction", async () => {
    const scope = new WindowRequestScope();
    const owner = new Owner();
    const work = vi.fn(async () => 42);
    owner.destroy();
    await expect(scope.run(owner, work)).rejects.toThrow("窗口已关闭");
    scope.close();
    await expect(scope.run(new Owner(), work)).rejects.toThrow("应用正在退出");
    expect(work).not.toHaveBeenCalled();
  });

  it("cleans up a failed request without preventing the next request", async () => {
    const scope = new WindowRequestScope();
    const owner = new Owner();
    await expect(scope.run(owner, () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
    expect(owner.listenerCount("destroyed")).toBe(0);
    await expect(scope.run(owner, async () => 42)).resolves.toBe(42);
    expect(owner.listenerCount("destroyed")).toBe(0);
  });

  it("does not lose cancellation while registering the owner listener", async () => {
    const scope = new WindowRequestScope();
    const owner = new Owner();
    const original = owner.once.bind(owner);
    vi.spyOn(owner, "once").mockImplementation((event, callback) => { original(event, callback); owner.destroy(); return owner; });
    const work = vi.fn(async () => 42);
    await expect(scope.run(owner, work)).rejects.toThrow("窗口已关闭");
    expect(work).not.toHaveBeenCalled();
    expect(owner.listenerCount("destroyed")).toBe(0);
  });
});
