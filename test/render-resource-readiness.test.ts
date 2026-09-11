import { afterEach, expect, it, vi } from "vitest";
import { observeRenderResources } from "../src/main/render-resource-readiness";
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const listeners: Record<string, any> = {};
  const request = Object.fromEntries(["onBeforeRequest", "onCompleted", "onErrorOccurred"].map(key => [key, (fn: any) => { listeners[key] = fn; }]));
  const tracker = observeRenderResources(request as never);
  return { tracker, listeners, start: (id: number, resourceType: string) => listeners.onBeforeRequest({ id, resourceType }, () => {}) };
}
it("waits for asynchronous scripts and their data requests, while ignoring stalled images", async () => {
  const { tracker, listeners, start } = fixture();
  start(1, "script"); start(2, "image");
  let ready = false;
  const waiting = tracker.wait().then(() => { ready = true; });
  await vi.advanceTimersByTimeAsync(1_800);
  expect(ready).toBe(false);
  start(3, "xhr"); listeners.onCompleted({ id: 1 });
  await vi.advanceTimersByTimeAsync(800);
  expect(ready).toBe(false);
  listeners.onCompleted({ id: 3 });
  await vi.advanceTimersByTimeAsync(800);
  await waiting;
  tracker.dispose();
  expect(Object.values(listeners)).toEqual([null, null, null]);
});
it("bounds stalled scripts and preserves caller cancellation", async () => {
  const { tracker, start } = fixture(); start(1, "script");
  const waiting = tracker.wait();
  await vi.advanceTimersByTimeAsync(12_000); await waiting;
  const controller = new AbortController();
  const reason = new Error("Cancelled");
  const cancelled = expect(tracker.wait(controller.signal)).rejects.toBe(reason);
  controller.abort(reason); await cancelled;
  tracker.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
