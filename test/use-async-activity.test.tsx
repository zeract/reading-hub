// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAsyncActivity } from "../src/renderer/use-async-activity";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
let activity: ReturnType<typeof useAsyncActivity>;
let root: Root;
let container: HTMLDivElement;
function Harness({ start }: { start?: () => Promise<void> }) {
  activity = useAsyncActivity();
  const { track } = activity;
  useEffect(() => { if (start) void track(start); }, [track, start]);
  return <output>{activity.busy ? "busy" : "idle"}</output>;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("stays busy until every overlapping operation settles", async () => {
  const first = deferred(); const second = deferred();
  await act(async () => { void activity.track(() => first.promise); void activity.track(() => second.promise); });
  expect(container.textContent).toBe("busy");
  await act(async () => second.resolve());
  expect(container.textContent).toBe("busy");
  await act(async () => first.resolve());
  expect(container.textContent).toBe("idle");
});

it("preserves errors without hiding another operation's activity", async () => {
  const pending = deferred(); const failure = new Error("Fixture failure");
  await act(async () => { void activity.track(() => pending.promise); });
  await act(async () => { await expect(activity.track(() => { throw failure; })).rejects.toBe(failure); });
  expect(activity.busy).toBe(true);
  await act(async () => pending.resolve()); expect(activity.busy).toBe(false);
  await act(async () => { await expect(activity.track(() => Promise.reject(failure))).rejects.toBe(failure); });
  expect(activity.busy).toBe(false);
});

it("preserves results including cancelled operations", async () => {
  const result = { cancelled: true, imported: 0 };
  await act(async () => { expect(await activity.track(() => result)).toBe(result); });
  expect(activity.busy).toBe(false);
});

it("allows nested tracked work without deadlocking or losing activity", async () => {
  const pending = deferred(); let finished!: Promise<void>;
  await act(async () => { finished = activity.track(() => activity.track(() => pending.promise)); });
  expect(activity.busy).toBe(true);
  await act(async () => { pending.resolve(); await finished; });
  expect(activity.busy).toBe(false);
});

it("retains both accepted operations across StrictMode effect replay", async () => {
  const first = deferred(); const second = deferred();
  const start = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await act(async () => root.render(<StrictMode><Harness start={start} /></StrictMode>));
  expect(start).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve()); expect(activity.busy).toBe(true);
  await act(async () => first.resolve()); expect(activity.busy).toBe(false);
});

it("keeps detached completion from changing another mounted activity owner", async () => {
  const old = deferred(); const current = deferred(); let oldWork!: Promise<void>;
  await act(async () => { oldWork = activity.track(() => old.promise); });
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness />));
  const track = activity.track;
  await act(async () => { void activity.track(() => current.promise); });
  await act(async () => { old.resolve(); await oldWork; });
  expect(activity.busy).toBe(true); expect(activity.track).toBe(track);
  await act(async () => current.resolve());
  expect(activity.busy).toBe(false); expect(activity.track).toBe(track);
});
