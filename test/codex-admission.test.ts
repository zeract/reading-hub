import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn(async () => undefined) }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
import { LocalCodexCli, invalidateCodexCommandDiscovery } from "../src/main/codex-cli";

const clients: LocalCodexCli[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((cli) => cli.close()));
  invalidateCodexCommandDiscovery();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Synthetic protocol peer: no real CLI, account, article or model request. */
function bridge() {
  vi.useFakeTimers();
  const started: string[] = [], interrupted: string[] = [];
  let nextThread = 0;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    unref: vi.fn(), stdin: undefined as unknown as Writable,
    kill: vi.fn(() => { queueMicrotask(() => child.emit("close", 0)); return true; })
  });
  const send = (message: unknown) => child.stdout.write(JSON.stringify(message) + "\n");
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString());
      queueMicrotask(() => {
        if (message.method === "initialize") send({ id: message.id, result: {} });
        if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: `thread-${++nextThread}` } } });
        if (message.method === "turn/start") {
          started.push(message.params.threadId);
          send({ id: message.id, result: { turn: { id: `turn-${message.params.threadId}` } } });
        }
        if (message.method === "turn/interrupt") {
          interrupted.push(message.params.threadId);
          // Acknowledging the request does not mean the turn has stopped.
          send({ id: message.id, result: {} });
        }
      });
      done();
    }
  });
  mocks.spawn.mockReturnValue(child);
  const cli = new LocalCodexCli(); clients.push(cli);
  return {
    cli, started, interrupted,
    complete(threadId: string) {
      send({ method: "item/agentMessage/delta", params: { threadId, delta: `answer-${threadId}` } });
      send({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
    }
  };
}

describe("local AI shared task admission", () => {
  it("holds cancelled turn capacity until completion, then starts the next queued question", async () => {
    const peer = bridge(), controller = new AbortController();
    const first = peer.cli.ask("Fixture", "Synthetic", { effort: "medium" }, controller.signal).catch((error: Error) => error);
    const second = peer.cli.ask("Fixture", "Synthetic", { effort: "medium" });
    const third = peer.cli.ask("Fixture", "Synthetic", { effort: "medium" });
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.started).toEqual(["thread-1", "thread-2"]);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.interrupted).toEqual(["thread-1"]);
    expect(peer.started).toHaveLength(2);
    peer.complete("thread-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.started).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect((await first as Error).message).toContain("已取消");
    peer.complete("thread-2"); peer.complete("thread-3");
    await expect(second).resolves.toBe("answer-thread-2");
    await expect(third).resolves.toBe("answer-thread-3");
    await peer.cli.close();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles active and queued questions on shutdown without starting extra threads", async () => {
    const peer = bridge();
    const pending = Array.from({ length: 5 }, () => peer.cli.ask("Fixture", "Synthetic", { effort: "medium" }).catch((error: Error) => error));
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.started).toHaveLength(2);
    await peer.cli.close();
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ message: expect.stringContaining("已取消") });
    expect(peer.started).toHaveLength(2);
    await expect(peer.cli.ask("Fixture", "Synthetic", { effort: "medium" })).rejects.toThrow("已取消");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
