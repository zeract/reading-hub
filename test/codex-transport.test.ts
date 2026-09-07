import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn(async () => undefined) }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
import { LocalCodexCli, invalidateCodexCommandDiscovery } from "../src/main/codex-cli";

const clients: LocalCodexCli[] = [];
afterEach(() => { for (const cli of clients.splice(0)) cli.dispose(); invalidateCodexCommandDiscovery(); vi.clearAllMocks(); });

function fixture(mode: "server" | "exec", output: (child: any, server: boolean) => void) {
  mocks.spawn.mockImplementation((_command, args) => {
    const server = args[0] === "app-server";
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, unref: vi.fn(), stdin: undefined as any, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.killed = true; queueMicrotask(() => child.emit("close", 0)); return true; });
    const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        if (server) {
          const message = JSON.parse(chunk.toString());
          queueMicrotask(() => {
            if (message.method === "initialize") send(mode === "exec" ? { id: message.id, error: { message: "unsupported" } } : { id: message.id, result: {} });
            if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "fixture-thread" } } });
            if (message.method === "turn/start") {
              send({ id: message.id, result: { turn: { id: "fixture-turn" } } });
              output(child, true);
            }
          });
        }
        done();
      },
      final(done) { if (!server) queueMicrotask(() => output(child, false)); done(); }
    });
    return child;
  });
  const cli = new LocalCodexCli(); clients.push(cli); return cli;
}

function answerFrames(server: boolean, answer: string): Buffer {
  return Buffer.from(server
    ? JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "fixture-thread", delta: answer } }) + "\n" + JSON.stringify({ method: "turn/completed", params: { threadId: "fixture-thread", turn: { status: "completed" } } }) + "\n"
    : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }) + "\n");
}

describe.each(["server", "exec"] as const)("local AI %s byte transport", (mode) => {
  it("preserves multilingual text when every UTF-8 byte arrives separately", async () => {
    const answer = "中文与 emoji 🧪 café";
    const cli = fixture(mode, (child, server) => {
      for (const byte of answerFrames(server, answer)) child.stdout.write(Buffer.from([byte]));
      if (!server) child.emit("close", 0);
    });
    const delta = vi.fn();
    expect(await cli.askStream("Fixture", "Synthetic context", { effort: "medium" }, delta)).toBe(answer);
    expect(delta.mock.calls.flat().join("")).toBe(answer);
  });

  it("does not discard complete messages batched into one large output chunk", async () => {
    const cli = fixture(mode, (child, server) => {
      const ignored = (JSON.stringify({ type: "diagnostic", padding: "x".repeat(1000) }) + "\n").repeat(100);
      child.stdout.write(Buffer.concat([Buffer.from(ignored), answerFrames(server, "Expected answer")]));
      // Force EOF to expose a lost frame without waiting for the request timeout.
      child.emit("close", 0);
    });
    expect(await cli.ask("Fixture", "Synthetic context", { effort: "medium" })).toBe("Expected answer");
  });

  it("rejects an oversized unfinished frame promptly and can answer on a fresh process", async () => {
    let oversized = true;
    const children: any[] = [];
    const cli = fixture(mode, (child, server) => {
      children.push(child);
      if (oversized) child.stdout.write(Buffer.from("private-fixture-" + "x".repeat(1_000_000)));
      else { child.stdout.write(answerFrames(server, "Retry answer")); if (!server) child.emit("close", 0); }
    });
    await expect(cli.ask("Fixture", "Synthetic context", { effort: "medium" })).rejects.toThrow("单条消息过大");
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    oversized = false;
    expect(await cli.ask("Fixture", "Synthetic context", { effort: "medium" })).toBe("Retry answer");
    expect(children[1]).not.toBe(children[0]);
  });

  it("accepts an escaped JSON answer larger than the visible-text limit on the wire", async () => {
    const answer = "中".repeat(40_000);
    const cli = fixture(mode, (child, server) => {
      child.stdout.write(Buffer.from(answerFrames(server, answer).toString().replaceAll("中", "\\u4e2d")));
      if (!server) child.emit("close", 0);
    });
    expect(await cli.ask("Fixture", "Synthetic context", { effort: "medium" })).toBe(answer);
  });
});

it.each(["Revised final answer", "b"])("bounds exec deltas and accepts the authoritative snapshot %s", async (final) => {
  const cli = fixture("exec", (child) => {
    for (const text of ["a".repeat(39_999), "b".repeat(100), "ignored"]) {
      child.stdout.write(JSON.stringify({ type: "agent_message.delta", delta: text }) + "\n");
    }
    child.stdout.write(answerFrames(false, final)); child.emit("close", 0);
  });
  const delta = vi.fn();
  expect(await cli.askStream("Fixture", "Synthetic context", { effort: "medium" }, delta)).toBe(final);
  expect(delta.mock.calls.flat().join("")).toBe("a".repeat(39_999) + "b");
});
