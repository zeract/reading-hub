// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWindowFullscreen } from "../src/renderer/use-window-fullscreen";

let root: Root;
let container: HTMLDivElement;
let snapshot: ReturnType<typeof vi.fn>;
let listeners: Array<(value: boolean) => void>;
let cleanups: Array<ReturnType<typeof vi.fn>>;
function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function Harness() { return <output>{String(useWindowFullscreen())}</output>; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  snapshot = vi.fn(async () => false); listeners = []; cleanups = [];
  Object.defineProperty(window, "reader", { configurable: true, value: {
    isWindowFullscreen: snapshot,
    onWindowFullscreenChange: (listener: (value: boolean) => void) => {
      listeners.push(listener);
      const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup;
    }
  } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("accepts the initial snapshot and then follows both event transitions", async () => {
  snapshot.mockResolvedValue(true);
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe("true");
  await act(async () => listeners[0](false)); expect(container.textContent).toBe("false");
  await act(async () => listeners[0](true)); expect(container.textContent).toBe("true");
});

it.each([true, false])("keeps the latest event %s ahead of an older startup read", async (eventValue) => {
  const read = deferred(); snapshot.mockReturnValue(read.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => { listeners[0](!eventValue); listeners[0](eventValue); });
  await act(async () => read.resolve(!eventValue));
  expect(container.textContent).toBe(String(eventValue));
});

it.each(["rejection", "throw"])("continues receiving events after a snapshot %s", async (failure) => {
  if (failure === "throw") snapshot.mockImplementation(() => { throw new Error("Bridge unavailable"); });
  else snapshot.mockRejectedValue(new Error("Snapshot unavailable"));
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toBe("false");
  await act(async () => listeners[0](true)); expect(container.textContent).toBe("true");
});

it("ignores snapshots and saved event callbacks from an unmounted owner", async () => {
  const old = deferred(); snapshot.mockReturnValueOnce(old.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(null));
  expect(cleanups[0]).toHaveBeenCalledOnce();
  await act(async () => root.render(<Harness />));
  await act(async () => { listeners[0](true); old.resolve(true); });
  expect(container.textContent).toBe("false");
  await act(async () => listeners[1](true)); expect(container.textContent).toBe("true");
});

it("isolates the discarded subscription and read during StrictMode replay", async () => {
  const old = deferred(); const current = deferred();
  snapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  expect(listeners).toHaveLength(2); expect(cleanups[0]).toHaveBeenCalledOnce();
  await act(async () => current.resolve(true)); expect(container.textContent).toBe("true");
  await act(async () => { old.resolve(false); listeners[0](false); });
  expect(container.textContent).toBe("true");
  await act(async () => listeners[1](false)); expect(container.textContent).toBe("false");
});
