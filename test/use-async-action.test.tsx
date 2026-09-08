// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAsyncAction } from "../src/renderer/use-async-action";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let action: ReturnType<typeof useAsyncAction>;
let root: Root;
let container: HTMLDivElement;
function Harness({ start }: { start?: (isCurrent: () => boolean) => Promise<void> }) {
  action = useAsyncAction();
  const { run } = action;
  useEffect(() => { if (start) void run(start); }, [run, start]);
  return <output>{action.busy ? "busy" : "idle"}:{action.error}</output>;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("admits one command synchronously while React still shows the previous state", async () => {
  const request = deferred(); const task = vi.fn(() => request.promise);
  await act(async () => { void action.run(task); void action.run(task); });
  expect(task).toHaveBeenCalledOnce(); expect(action.isRunning()).toBe(true);
  expect(container.textContent).toBe("busy:");
  await act(async () => request.resolve());
  expect(action.isRunning()).toBe(false); expect(container.textContent).toBe("idle:");
});

it("keeps a replacement locked when an invalidated action completes", async () => {
  const old = deferred(); const current = deferred(); let oldIsCurrent!: () => boolean;
  await act(async () => { void action.run((check) => { oldIsCurrent = check; return old.promise; }); });
  await act(async () => { action.invalidate(); void action.run(() => current.promise); });
  expect(oldIsCurrent()).toBe(false);
  await act(async () => old.resolve());
  expect(action.isRunning()).toBe(true); expect(container.textContent).toBe("busy:");
  await act(async () => current.resolve());
});

it("does not surface obsolete errors while a replacement is running", async () => {
  const old = deferred(); const current = deferred();
  await act(async () => { void action.run(() => old.promise); });
  await act(async () => { action.invalidate(); void action.run(() => current.promise); });
  await act(async () => old.reject(new Error("Obsolete failure")));
  expect(action.error).toBeUndefined(); expect(action.busy).toBe(true);
  await act(async () => current.reject(new Error("Current failure")));
  expect(action.error).toBe("Current failure"); expect(action.busy).toBe(false);
});

it("formats synchronous failures and clears them when retry starts", async () => {
  await act(async () => { await action.run(() => { throw new Error("Error invoking remote method 'source:confirm': Error: Retry required"); }); });
  expect(action.error).toBe("Retry required"); expect(action.isRunning()).toBe(false);
  const request = deferred();
  await act(async () => { void action.run(() => request.promise); });
  expect(action.error).toBeUndefined(); expect(action.busy).toBe(true);
  await act(async () => request.resolve());
});

it("invalidates on unmount and refuses commands from retained callbacks", async () => {
  const request = deferred(); let isCurrent!: () => boolean;
  await act(async () => { void action.run((check) => { isCurrent = check; return request.promise; }); });
  const run = action.run;
  await act(async () => root.render(null));
  expect(isCurrent()).toBe(false);
  const late = vi.fn(); await run(late);
  expect(late).not.toHaveBeenCalled();
  await act(async () => request.reject(new Error("Detached failure")));
});

it("starts a fresh action after StrictMode effect replay", async () => {
  const old = deferred(); const current = deferred(); const guards: Array<() => boolean> = [];
  const start = vi.fn((check: () => boolean) => { guards.push(check); return guards.length === 1 ? old.promise : current.promise; });
  await act(async () => root.render(<StrictMode><Harness start={start} /></StrictMode>));
  expect(start).toHaveBeenCalledTimes(2); expect(guards[0]()).toBe(false); expect(guards[1]()).toBe(true);
  await act(async () => old.resolve());
  expect(action.busy).toBe(true);
  await act(async () => current.resolve());
  expect(action.busy).toBe(false);
});

it("keeps action functions stable across state updates", async () => {
  const initial = action;
  await act(async () => action.fail(new Error("Discovery failed")));
  expect(action.error).toBe("Discovery failed");
  await act(async () => action.clearError());
  expect(action.error).toBeUndefined();
  for (const name of ["run", "invalidate", "fail", "clearError", "isRunning"] as const) expect(action[name]).toBe(initial[name]);
});
