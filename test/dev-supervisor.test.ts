import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installDevelopmentSupervisorGuard } from "../src/main/dev-supervisor";

class FakeRuntime extends EventEmitter {
  constructor(
    readonly env: NodeJS.ProcessEnv,
    readonly connected?: boolean
  ) {
    super();
  }
}

describe("development supervisor lifecycle", () => {
  it("does not install an orphan guard for packaged or ordinary Electron starts", () => {
    const runtime = new FakeRuntime({});
    const quit = vi.fn();

    installDevelopmentSupervisorGuard(runtime, quit);
    runtime.emit("disconnect");

    expect(quit).not.toHaveBeenCalled();
  });

  it("quits exactly once when the development supervisor IPC channel closes", () => {
    const runtime = new FakeRuntime({ READING_HUB_DEV_SUPERVISOR_IPC: "1" }, true);
    const quit = vi.fn();

    installDevelopmentSupervisorGuard(runtime, quit);
    runtime.emit("disconnect");
    runtime.emit("disconnect");

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("covers a supervisor that dies before the Electron main module finishes loading", async () => {
    const runtime = new FakeRuntime({ READING_HUB_DEV_SUPERVISOR_IPC: "1" }, false);
    const quit = vi.fn();

    installDevelopmentSupervisorGuard(runtime, quit);
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("launches development Electron with an IPC liveness channel and bounded shutdown", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts", "dev.mjs"), "utf8");

    expect(source).toContain('READING_HUB_DEV_SUPERVISOR_IPC: "1"');
    expect(source).toContain('["inherit", "inherit", "inherit", "ipc"]');
    expect(source).toContain('await Promise.allSettled(children.map((child) => terminateChild(child)))');
    expect(source).toContain('["SIGINT", "SIGTERM", "SIGHUP"]');
  });
});
