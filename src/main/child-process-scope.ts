import type { ChildProcessWithoutNullStreams } from "node:child_process";

const TERMINATION_GRACE_MS = 1_000;
type Child = ChildProcessWithoutNullStreams;
type OwnedProcess = { done: Promise<void>; stop(): void };

/** Own only explicitly registered children, never arbitrary PIDs or process
 * groups. Cancellation requests SIGTERM, then SIGKILL after a bounded grace
 * period. A sent signal (`child.killed`) is not evidence of process exit. */
export class ChildProcessScope {
  private readonly owned = new Map<Child, OwnedProcess>();
  private closing = false;
  private closed?: Promise<void>;

  track(child: Child): Child {
    if (this.closing) throw new Error("应用正在退出，无法启动本地 AI。");
    if (this.owned.has(child)) return child;
    let stopped = false;
    let finished = false;
    let exited = false;
    let timer: NodeJS.Timeout | undefined;
    let resolve!: () => void;
    const done = new Promise<void>((complete) => { resolve = complete; });
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", finish);
      this.owned.delete(child);
      // On natural exit stdout still owns its final bytes until close. Only
      // abandoned operations may discard their pipes here.
      if (stopped) {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
      resolve();
    };
    const signal = (name: NodeJS.Signals) => {
      try { child.kill(name); } catch { /* Never expose native process diagnostics. */ }
    };
    const stop = () => {
      if (stopped || finished) return;
      stopped = true;
      if (exited) { finish(); return; }
      // Keep this short timer referenced so application shutdown can finish
      // cleanup before Electron exits, including for an unref'ed bridge.
      timer = setTimeout(() => { signal("SIGKILL"); finish(); }, TERMINATION_GRACE_MS);
      signal("SIGTERM");
    };
    // Natural exit can precede the final stdout bytes and stdio close. Keep
    // ownership until close so cancellation can still release inherited pipes.
    const onExit = () => { exited = true; if (stopped) finish(); };
    const onError = () => { if (!finished) { if (child.pid === undefined) finish(); else stop(); } };
    this.owned.set(child, { done, stop });
    child.once("exit", onExit); child.once("close", finish);
    // Native signal failures may emit another error after bounded cleanup;
    // keep an observer until actual stdio close, then release it.
    child.on("error", onError);
    child.once("close", () => child.removeListener("error", onError));
    return child;
  }

  terminate(child: Child): Promise<void> {
    const process = this.owned.get(child);
    process?.stop();
    return process?.done ?? Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closing = true;
      const processes = [...this.owned.values()];
      for (const process of processes) process.stop();
      this.closed = Promise.all(processes.map((process) => process.done)).then(() => undefined);
    }
    return this.closed;
  }
}
