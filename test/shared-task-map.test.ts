import { describe, expect, it, vi } from "vitest";
import { SharedTaskMap } from "../src/main/shared-task-map";

describe("shared task ownership", () => {
  it("uses only the first loader for equivalent active keys and does not retain settled results", async () => {
    const tasks = new SharedTaskMap<string>();
    const first = vi.fn(async () => "first"), ignored = vi.fn(async () => "other");
    expect(await Promise.all([tasks.run("key", first), tasks.run("key", ignored)])).toEqual(["first", "first"]);
    expect(ignored).not.toHaveBeenCalled();
    expect(await tasks.run("key", ignored)).toBe("other");
  });

  it("does not attach an already cancelled waiter to an active task", async () => {
    const tasks = new SharedTaskMap<string>();
    const controller = new AbortController(); controller.abort(new Error("already left"));
    const load = vi.fn(async () => "active");
    const first = tasks.run("key", load);
    await expect(tasks.run("key", load, controller.signal)).rejects.toThrow("already left");
    expect(await first).toBe("active");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("releases all abort listeners after a shared result (failure=%s)", async (failure) => {
    const tasks = new SharedTaskMap<string>();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const load = vi.fn(async () => { if (failure) throw new Error("fixture failure"); return "done"; });
    const results = await Promise.allSettled([tasks.run("key", load, controller.signal), tasks.run("key", load, controller.signal)]);
    expect(results.map((result) => result.status)).toEqual([failure ? "rejected" : "fulfilled", failure ? "rejected" : "fulfilled"]);
    expect(load).toHaveBeenCalledTimes(1);
    for (const [type, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(type, listener);
  });

  it("releases a synchronously failing loader for a fresh attempt", async () => {
    const tasks = new SharedTaskMap<string>();
    await expect(tasks.run("key", () => { throw new Error("fixture throw"); })).rejects.toThrow("fixture throw");
    await expect(tasks.run("key", async () => "recovered")).resolves.toBe("recovered");
  });

  it("observes late failure after cancellation without removing the new task", async () => {
    const tasks = new SharedTaskMap<string>();
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: string) => void;
    const controller = new AbortController();
    const oldLoad = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectOld = reject; }));
    const old = expect(tasks.run("key", oldLoad, controller.signal)).rejects.toThrow("abandoned");
    await vi.waitFor(() => expect(oldLoad).toHaveBeenCalled());
    controller.abort(new Error("abandoned")); await old;
    const newLoad = vi.fn(() => new Promise<string>((resolve) => { resolveNew = resolve; }));
    const replacement = tasks.run("key", newLoad);
    rejectOld(new Error("late fixture failure"));
    await vi.waitFor(() => expect(newLoad).toHaveBeenCalled());
    const ignored = vi.fn(async () => "wrong task");
    const joined = tasks.run("key", ignored);
    resolveNew("replacement");
    expect(await Promise.all([replacement, joined])).toEqual(["replacement", "replacement"]);
    expect(ignored).not.toHaveBeenCalled();
  });
});
