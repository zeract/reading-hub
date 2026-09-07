import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcessScope } from "../src/main/child-process-scope";

afterEach(() => vi.useRealTimers());
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, killed: false, kill: vi.fn(),
    stdin: { destroy: vi.fn() }, stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() }
  });
  child.kill.mockImplementation(() => { child.killed = true; return true; });
  const scope = new ChildProcessScope(); scope.track(child as never);
  return { child, scope };
}

describe("owned child process lifetime", () => {
  it("waits for grace, escalates once despite killed=true, and releases owned pipes", async () => {
    vi.useFakeTimers();
    const { child, scope } = fixture();
    const closed = scope.close();
    expect(scope.close()).toBe(closed);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await closed;
    expect(child.kill.mock.calls.map((args) => args[0])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await scope.terminate(child as never);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("cancels escalation on confirmed exit and leaves natural final output readable", async () => {
    vi.useFakeTimers();
    const { child, scope } = fixture();
    child.emit("exit", 0);
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    child.emit("close", 0); await scope.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroy).not.toHaveBeenCalled();
  });

  it("releases still-open inherited pipes after exit without signalling the exited PID", async () => {
    const { child, scope } = fixture();
    child.emit("exit", 0);
    await scope.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
  });

  it("clears its timer when a gracefully terminated process exits", async () => {
    vi.useFakeTimers();
    const { child, scope } = fixture();
    const stopped = scope.terminate(child as never);
    child.emit("exit", null, "SIGTERM"); await stopped;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes a spawn failure without signalling an unrelated PID", async () => {
    const { child, scope } = fixture();
    child.pid = undefined as never;
    child.emit("error", new Error("synthetic spawn failure"));
    await scope.close();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds cleanup even if the native signal operation throws", async () => {
    vi.useFakeTimers();
    const { child, scope } = fixture();
    child.kill.mockImplementation(() => { throw new Error("synthetic native detail"); });
    const stopped = scope.close();
    await vi.advanceTimersByTimeAsync(1_000); await stopped;
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(() => child.emit("error", new Error("late synthetic native error"))).not.toThrow();
    child.emit("close", null);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("terminates a real fixture child that ignores SIGTERM", async () => {
    const scope = new ChildProcessScope();
    const child = scope.track(spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: "pipe" }));
    const exited = once(child, "exit");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([once(child.stdout, "data"), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 2_000); })]);
      clearTimeout(timer);
      await scope.close();
      const [code, signal] = await exited;
      expect(code).toBeNull(); expect(signal).toBe("SIGKILL");
    } finally { clearTimeout(timer); await scope.close(); }
  });
});
