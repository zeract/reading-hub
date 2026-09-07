// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAiStreamSubscription, useAiTextStream } from "../src/renderer/ai-stream";
import type { AiStreamEvent, AiStreamRequest } from "../src/shared/types";

let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useAiTextStream>;
let emit: (event: AiStreamEvent) => void;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const unsubscribe = vi.fn();
const startAiStream = vi.fn();
const cancelAiStream = vi.fn();
const request = (requestId: string): AiStreamRequest => ({ requestId, request: {
  provider: "openai", question: "Fixture?", article: { title: "Fixture", url: "https://example.com", text: "Synthetic" }
} });
function Surface() { state = useAiTextStream(); return <div>{state.text}|{state.error}|{String(state.busy)}</div>; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  startAiStream.mockReset().mockResolvedValue(undefined);
  cancelAiStream.mockReset().mockResolvedValue(undefined); unsubscribe.mockReset();
  vi.stubGlobal("reader", { onAiStream: (listener: typeof emit) => { emit = listener; return unsubscribe; }, startAiStream, cancelAiStream });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Surface />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function delta(text: string, requestId = "first") { await act(async () => emit({ type: "delta", requestId, text })); }
async function paint() { await act(async () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } }); }

it("publishes the final partial text on error without another animation frame", async () => {
  await act(async () => state.start(request("first")));
  await delta("partial "); await delta("answer");
  expect(state.text).toBe("");
  await act(async () => emit({ type: "error", requestId: "first", message: "Fixture failure" }));
  expect(state.text).toBe("partial answer"); expect(state.error).toBe("Fixture failure");
  expect(state.busy).toBe(false); expect(frames.size).toBe(0);
});
it("coalesces deltas and honors an authoritative completion snapshot", async () => {
  await act(async () => state.start(request("first")));
  for (let i = 0; i < 50; i++) await delta("x");
  expect(state.text).toBe(""); expect(frames.size).toBe(1);
  await paint(); expect(state.text).toBe("x".repeat(50));
  await delta("draft");
  await act(async () => emit({ type: "complete", requestId: "first", answer: { provider: "openai", model: "fixture", text: "Revised" } }));
  expect(state.text).toBe("Revised"); expect(frames.size).toBe(0);
});
it("discards queued and late events across reset, and prevents duplicate starts", async () => {
  await act(async () => { void state.start(request("first")); void state.start(request("duplicate")); });
  expect(startAiStream).toHaveBeenCalledTimes(1);
  await delta("old"); await act(async () => state.reset());
  expect(frames.size).toBe(0); expect(cancelAiStream).toHaveBeenCalledWith("first");
  await act(async () => state.start(request("second")));
  await delta("late"); await delta("new", "second"); await paint();
  await act(async () => emit({ type: "error", requestId: "first", message: "Old error" }));
  expect(state.text).toBe("new"); expect(state.error).toBeUndefined(); expect(state.busy).toBe(true);
});
it("flushes pending text when IPC rejects and cancels pending work on unmount", async () => {
  let reject!: (reason: Error) => void;
  startAiStream.mockImplementationOnce(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  let started!: Promise<void>;
  await act(async () => { started = state.start(request("first")); });
  await delta("partial");
  await act(async () => { reject(new Error("Fixture transport failure")); await started; });
  expect(state.text).toBe("partial"); expect(state.error).toBe("Fixture transport failure"); expect(frames.size).toBe(0);
  await act(async () => state.start(request("second"))); await delta("pending", "second");
  await act(async () => root.unmount());
  expect(frames.size).toBe(0); expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(cancelAiStream).toHaveBeenCalledWith("second");
});

it("batches the shared subscription before notifying a conversation surface", async () => {
  const listener = vi.fn();
  let active = "first";
  function Conversation({ onEvent }: { onEvent: (event: AiStreamEvent) => void }) {
    useAiStreamSubscription(onEvent, () => active);
    return null;
  }
  await act(async () => root.render(<Conversation onEvent={listener} />));
  await delta("unrelated", "other"); expect(frames.size).toBe(0);
  for (let i = 0; i < 50; i++) await delta("x");
  expect(listener).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
  const latest = vi.fn();
  await act(async () => root.render(<Conversation onEvent={latest} />));
  await paint();
  expect(listener).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith({ type: "delta", requestId: "first", text: "x".repeat(50) });
  await delta("obsolete"); active = "second";
  await delta("current", "second"); await paint();
  expect(latest).toHaveBeenLastCalledWith({ type: "delta", requestId: "second", text: "current" });
});

it("delivers partial text before a terminal error and drops queued work on unsubscribe", async () => {
  const listener = vi.fn();
  function Conversation() { useAiStreamSubscription(listener, () => "first"); return null; }
  await act(async () => root.render(<Conversation />));
  await delta("part"); await delta("ial");
  const terminal = { type: "error" as const, requestId: "first", message: "Fixture error" };
  await act(async () => emit(terminal));
  expect(listener.mock.calls.map(([event]) => event)).toEqual([
    { type: "delta", requestId: "first", text: "partial" }, terminal
  ]);
  expect(frames.size).toBe(0);
  await delta("pending"); await act(async () => root.unmount());
  expect(frames.size).toBe(0); expect(listener).toHaveBeenCalledTimes(2);
});
