import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { combineAbortSignals, RequestAbortedError } from "../src/main/cancellation";

const listeners = (controller: AbortController) => getEventListeners(controller.signal, "abort");

it("registers a repeated parent once and releases it completely", () => {
  const parent = new AbortController();
  const scope = combineAbortSignals(parent.signal, undefined, parent.signal, parent.signal);
  try { expect(listeners(parent)).toHaveLength(1); }
  finally { scope.dispose(); }
  expect(listeners(parent)).toHaveLength(0);
  scope.dispose();
  parent.abort();
  expect(scope.signal?.aborted).toBe(false);
});

it.each([0, 1, 2])("detaches every parent as soon as parent %s cancels", (index) => {
  const parents = Array.from({ length: 3 }, () => new AbortController());
  const scope = combineAbortSignals(...parents.map((parent) => parent.signal));
  const reason = new Error("Fixture cancellation");
  try {
    parents[index].abort(reason);
    expect(scope.signal?.reason).toBe(reason);
    for (const parent of parents) expect(listeners(parent)).toHaveLength(0);
    for (const parent of parents) parent.abort(new Error("Later cancellation"));
    expect(scope.signal?.reason).toBe(reason);
  } finally { scope.dispose(); }
});

it("leaves no listeners when a later parent is already cancelled", () => {
  const active = new AbortController();
  const cancelled = new AbortController();
  cancelled.abort("Fixture cancellation");
  const scope = combineAbortSignals(active.signal, cancelled.signal, active.signal);
  try {
    expect(scope.signal?.reason).toBeInstanceOf(RequestAbortedError);
    expect(scope.signal?.reason.message).toBe("Fixture cancellation");
    expect(listeners(active)).toHaveLength(0);
  } finally { scope.dispose(); }
});

it("cleans up before notifying downstream cancellation observers", () => {
  const first = new AbortController();
  const second = new AbortController();
  const scope = combineAbortSignals(first.signal, second.signal);
  const observed: number[] = [];
  const reason = new Error("First cancellation");
  scope.signal!.addEventListener("abort", () => {
    observed.push(listeners(first).length, listeners(second).length);
    second.abort(new Error("Reentrant cancellation"));
  }, { once: true });
  try {
    first.abort(reason);
    expect(observed).toEqual([0, 0]);
    expect(scope.signal?.reason).toBe(reason);
  } finally { scope.dispose(); }
});

it("preserves unrelated parent listeners when disposed without cancellation", () => {
  const parent = new AbortController();
  const unrelated = vi.fn();
  parent.signal.addEventListener("abort", unrelated, { once: true });
  const scope = combineAbortSignals(parent.signal);
  scope.dispose();
  expect(listeners(parent)).toEqual([unrelated]);
  expect(parent.signal.aborted).toBe(false);
  parent.abort();
  expect(unrelated).toHaveBeenCalledTimes(1);
  expect(scope.signal?.aborted).toBe(false);
});

it("supports absent parents and keeps the first already-cancelled reason", () => {
  const empty = combineAbortSignals(undefined);
  expect(empty.signal).toBeUndefined();
  empty.dispose();
  const first = new AbortController();
  const second = new AbortController();
  first.abort(new Error("First")); second.abort(new Error("Second"));
  const scope = combineAbortSignals(first.signal, second.signal);
  expect(scope.signal?.reason).toBe(first.signal.reason);
  scope.dispose();
});
