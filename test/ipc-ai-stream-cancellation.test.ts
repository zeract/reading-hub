import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
      handle: vi.fn((channel: string, listener: (...args: any[]) => unknown) => { handlers.set(channel, listener); })
    },
    BrowserWindow: { fromWebContents: vi.fn(() => undefined) },
    dialog: { showOpenDialog: vi.fn() },
    shell: { openExternal: vi.fn() }
  };
});

vi.mock("electron", () => electron);

import { registerIpcHandlers } from "../src/main/ipc-handlers";
import type { ApplicationServices } from "../src/main/app-services";
import { IPC_CHANNELS } from "../src/shared/ipc";
import type { AiAnswer, AiQuestionRequest } from "../src/shared/types";

type TestSender = {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

type PendingStream = {
  request: AiQuestionRequest;
  onDelta: (text: string) => void;
  signal: AbortSignal | undefined;
  resolve(answer: AiAnswer): void;
  reject(error: Error): void;
};

function createSender(id: number): TestSender {
  return {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    removeListener: vi.fn()
  };
}

function streamPayload(requestId: string) {
  return {
    requestId,
    request: {
      provider: "codex-cli" as const,
      question: requestId,
      article: {
        title: "Test article",
        url: "https://example.com/post",
        text: "A short source paragraph."
      }
    }
  };
}

function answer(text: string): AiAnswer {
  return { provider: "codex-cli", model: "gpt-5.6-luna · low", text };
}

function createHarness(): { pending: PendingStream[]; register(): () => Promise<void> } {
  const pending: PendingStream[] = [];
  const learningAssistant = {
    askStream: vi.fn((request: AiQuestionRequest, onDelta: (text: string) => void, signal?: AbortSignal) =>
      new Promise<AiAnswer>((resolve, reject) => {
        pending.push({ request, onDelta, signal, resolve, reject });
      }))
  };

  return {
    pending,
    register: () => registerIpcHandlers({ learningAssistant } as unknown as ApplicationServices)
  };
}

function handler(channel: string): (...args: any[]) => Promise<unknown> | unknown {
  const registered = electron.handlers.get(channel);
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`);
  return registered;
}

async function flushAsyncWork(): Promise<void> {
  // `askStream` is scheduled after the IPC invoke resolves, and terminal
  // events are chained from the service promise. Drain both microtask hops.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AI stream IPC cancellation", () => {
  it("waits for a cancelled stream to actually settle before completing IPC shutdown", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(61);
    await handler(IPC_CHANNELS.ai.askStream)({ sender }, streamPayload("slow-cleanup"));
    let drained = false;
    const closing = drain().then(() => { drained = true; });
    await flushAsyncWork();
    expect(harness.pending[0].signal?.aborted).toBe(true);
    expect(drained).toBe(false);
    harness.pending[0].resolve(answer("late answer"));
    await closing;
    expect(drained).toBe(true);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("releases its owner listener after the last stream settles", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(62);
    await handler(IPC_CHANNELS.ai.askStream)({ sender }, streamPayload("complete"));
    harness.pending[0].resolve(answer("done"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sender.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
    await drain();
  });

  it("keeps a replacement cancellable after the old request with the same id settles", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(63);
    const start = handler(IPC_CHANNELS.ai.askStream);
    const cancel = handler(IPC_CHANNELS.ai.cancelStream);
    await start({ sender }, streamPayload("duplicate"));
    await start({ sender }, streamPayload("duplicate"));
    expect(harness.pending[0].signal?.aborted).toBe(true);
    harness.pending[0].resolve(answer("obsolete"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await cancel({ sender }, "duplicate");
    expect(harness.pending[1].signal?.aborted).toBe(true);
    harness.pending[1].reject(new Error("cancelled replacement"));
    await drain();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("cancels concurrent streams on owner destruction without affecting another owner", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const first = createSender(64);
    const second = createSender(65);
    const start = handler(IPC_CHANNELS.ai.askStream);
    for (let i = 0; i < 20; i++) await start({ sender: first }, streamPayload(`stream-${i}`));
    await start({ sender: second }, streamPayload("stream-0"));
    expect(first.once).toHaveBeenCalledTimes(1);
    first.isDestroyed.mockReturnValue(true);
    first.once.mock.calls[0][1]();
    for (const pending of harness.pending.slice(0, 20)) {
      expect(pending.signal?.aborted).toBe(true);
      pending.onDelta("late delta");
      pending.resolve(answer("late answer"));
    }
    const independent = harness.pending[20];
    expect(independent.signal?.aborted).toBe(false);
    independent.resolve(answer("independent answer"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledWith(IPC_CHANNELS.ai.streamEvent, expect.objectContaining({ type: "complete" }));
    await drain();
  });

  it("does not start scheduled provider work if shutdown occurs before its microtask", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(66);
    const admitted = handler(IPC_CHANNELS.ai.askStream)({ sender }, streamPayload("queued-request"));
    await drain();
    await admitted;
    expect(harness.pending).toHaveLength(0);
    expect(sender.send).not.toHaveBeenCalled();
    expect(sender.removeListener).toHaveBeenCalledTimes(1);
  });

  it("does not start provider work for a destroyed owner", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(67);
    sender.isDestroyed.mockReturnValue(true);
    await handler(IPC_CHANNELS.ai.askStream)({ sender }, streamPayload("destroyed"));
    await drain();
    expect(harness.pending).toHaveLength(0);
    expect(sender.once).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("reports a provider failure and releases the owner for a later retry", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(68);
    const start = handler(IPC_CHANNELS.ai.askStream);
    await start({ sender }, streamPayload("retry-request"));
    harness.pending[0].reject(new Error("Provider unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.ai.streamEvent, {
      type: "error", requestId: "retry-request", message: "Provider unavailable"
    });
    expect(sender.removeListener).toHaveBeenCalledTimes(1);
    await start({ sender }, streamPayload("retry-request"));
    expect(sender.once).toHaveBeenCalledTimes(2);
    harness.pending[1].resolve(answer("recovered"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.ai.streamEvent, expect.objectContaining({ type: "complete" }));
    await drain();
  });

  it("settles cleanly if the IPC transport fails while delivering a terminal event", async () => {
    const harness = createHarness();
    const drain = harness.register();
    const sender = createSender(69);
    sender.send.mockImplementation(() => { throw new Error("Transport destroyed"); });
    await handler(IPC_CHANNELS.ai.askStream)({ sender }, streamPayload("transport"));
    harness.pending[0].resolve(answer("done"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sender.removeListener).toHaveBeenCalledTimes(1);
    await drain();
  });

  it("stops IPC admission and drains pending handlers before releasing services", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((release) => { resolve = release; });
    const listSources = vi.fn(() => pending);
    const drain = registerIpcHandlers({ database: { listSources } } as unknown as ApplicationServices);
    const list = handler(IPC_CHANNELS.source.list);
    const request = list({ sender: createSender(10) });
    let drained = false;
    const closing = drain().then(() => { drained = true; });
    expect(electron.handlers.size).toBe(0);
    expect(() => list({ sender: createSender(10) })).toThrow("应用正在退出");
    await flushAsyncWork();
    expect(drained).toBe(false);
    resolve([]);
    await request;
    await closing;
    expect(drained).toBe(true);
    expect(listSources).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    electron.handlers.clear();
    vi.clearAllMocks();
  });

  it("cancels only the matching request in one renderer and suppresses its stale complete event", async () => {
    const harness = createHarness();
    harness.register();
    const sender = createSender(41);
    const start = handler(IPC_CHANNELS.ai.askStream);
    const cancel = handler(IPC_CHANNELS.ai.cancelStream);

    await start({ sender }, streamPayload("request-a"));
    await start({ sender }, streamPayload("request-b"));
    await flushAsyncWork();
    expect(harness.pending).toHaveLength(2);

    const [first, second] = harness.pending;
    await cancel({ sender }, "request-a");

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    first.onDelta("late first delta");
    first.resolve(answer("late first answer"));
    second.onDelta("second delta");
    second.resolve(answer("second answer"));
    await flushAsyncWork();

    const events = sender.send.mock.calls
      .filter(([channel]) => channel === IPC_CHANNELS.ai.streamEvent)
      .map(([, event]) => event);
    expect(events).toEqual([
      { type: "delta", requestId: "request-b", text: "second delta" },
      { type: "complete", requestId: "request-b", answer: answer("second answer") }
    ]);
  });

  it("scopes matching ids to the owning renderer and suppresses a cancelled stream's stale error", async () => {
    const harness = createHarness();
    harness.register();
    const firstSender = createSender(51);
    const secondSender = createSender(52);
    const start = handler(IPC_CHANNELS.ai.askStream);
    const cancel = handler(IPC_CHANNELS.ai.cancelStream);

    await start({ sender: firstSender }, streamPayload("shared-id"));
    await start({ sender: secondSender }, streamPayload("shared-id"));
    await flushAsyncWork();
    expect(harness.pending).toHaveLength(2);

    const [first, second] = harness.pending;
    await cancel({ sender: firstSender }, "shared-id");

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    first.reject(new Error("provider failure after cancellation"));
    second.resolve(answer("independent answer"));
    await flushAsyncWork();

    expect(firstSender.send).not.toHaveBeenCalled();
    expect(secondSender.send).toHaveBeenCalledWith(IPC_CHANNELS.ai.streamEvent, {
      type: "complete",
      requestId: "shared-id",
      answer: answer("independent answer")
    });
  });
});
