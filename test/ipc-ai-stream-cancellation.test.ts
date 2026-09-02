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
    once: vi.fn()
  };
}

function streamPayload(requestId: string) {
  return {
    requestId,
    request: {
      provider: "codex-cli" as const,
      task: "immersive-translation" as const,
      translationTarget: "zh" as const,
      question: requestId,
      translationSegments: [{ id: `segment-${requestId}`, text: "A short source paragraph." }]
    }
  };
}

function answer(text: string): AiAnswer {
  return { provider: "codex-cli", model: "gpt-5.6-luna · low", text };
}

function createHarness(): { pending: PendingStream[]; register(): void } {
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
