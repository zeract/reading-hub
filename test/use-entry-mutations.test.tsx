// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Entry } from "../src/shared/types";
import { useEntryMutations } from "../src/renderer/use-entry-mutations";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const entry = { id: "one" } as Entry;
let actions: ReturnType<typeof useEntryMutations>;
let root: Root;
let container: HTMLDivElement;
let saveRead: ReturnType<typeof vi.fn>;
let saveFavorite: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let committed: ReturnType<typeof vi.fn>;
let error: ReturnType<typeof vi.fn>;
let createErrorReporter: ReturnType<typeof vi.fn>;
function Harness({ autoRead = false }: { autoRead?: boolean }) {
  actions = useEntryMutations({ reload, onCommitted: committed, createErrorReporter });
  const { updateEntry } = actions;
  useEffect(() => { if (autoRead) void updateEntry(entry, "read", true); }, [autoRead, updateEntry]);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saveRead = vi.fn(async () => undefined); saveFavorite = vi.fn(async () => undefined);
  reload = vi.fn(async () => undefined); committed = vi.fn(); error = vi.fn();
  createErrorReporter = vi.fn(() => error);
  Object.defineProperty(window, "reader", { configurable: true, value: { markRead: saveRead, markFavorite: saveFavorite } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shares same-event and cross-view duplicates until the refreshed list is ready", async () => {
  const write = deferred(); const refresh = deferred();
  saveFavorite.mockReturnValue(write.promise); reload.mockReturnValue(refresh.promise);
  let first!: Promise<boolean>; let duplicate!: Promise<boolean>;
  const update = actions.updateEntry;
  await act(async () => {
    first = actions.updateEntry(entry, "favorite", true);
    duplicate = actions.updateEntry({ ...entry }, "favorite", true);
  });
  expect(duplicate).toBe(first); expect(saveFavorite).toHaveBeenCalledTimes(1);
  expect(createErrorReporter).toHaveBeenCalledTimes(1);
  expect(actions.isEntryUpdating(entry.id, "favorite")).toBe(true);
  await act(async () => write.resolve());
  expect(committed).toHaveBeenCalledExactlyOnceWith(entry.id, "favorite", true);
  expect(actions.isEntryUpdating(entry.id, "favorite")).toBe(true);
  await act(async () => { duplicate = actions.updateEntry(entry, "favorite", true); });
  expect(duplicate).toBe(first);
  await act(async () => { refresh.resolve(); expect(await first).toBe(true); });
  expect(actions.isEntryUpdating(entry.id, "favorite")).toBe(false);
  expect(actions.updateEntry).toBe(update);
});

it("preserves opposite intents in order and only joins the latest matching intent", async () => {
  const firstWrite = deferred(); saveRead.mockReturnValueOnce(firstWrite.promise);
  let first!: Promise<boolean>; let second!: Promise<boolean>; let third!: Promise<boolean>;
  await act(async () => {
    first = actions.updateEntry(entry, "read", true);
    second = actions.updateEntry(entry, "read", false);
    third = actions.updateEntry(entry, "read", true);
    expect(actions.updateEntry(entry, "read", true)).toBe(third);
  });
  expect(third).not.toBe(first); expect(saveRead).toHaveBeenCalledTimes(1);
  await act(async () => { firstWrite.resolve(); await Promise.all([first, second, third]); });
  expect(saveRead.mock.calls).toEqual([[entry.id, true], [entry.id, false], [entry.id, true]]);
  expect(committed.mock.calls).toEqual([[entry.id, "read", true], [entry.id, "read", false], [entry.id, "read", true]]);
  expect(actions.isEntryUpdating(entry.id, "read")).toBe(false);
});

it("does not block another article or another field on the same article", async () => {
  const write = deferred(); saveFavorite.mockReturnValueOnce(write.promise);
  let pending!: Promise<boolean>;
  await act(async () => { pending = actions.updateEntry(entry, "favorite", true); });
  await act(async () => {
    expect(await actions.updateEntry(entry, "read", true)).toBe(true);
    expect(await actions.updateEntry({ ...entry, id: "two" }, "favorite", true)).toBe(true);
  });
  expect(actions.isEntryUpdating(entry.id, "favorite")).toBe(true);
  expect(actions.isEntryUpdating(entry.id, "read")).toBe(false);
  expect(actions.isEntryUpdating("two", "favorite")).toBe(false);
  await act(async () => { write.resolve(); await pending; });
});

it("reports a failed write once, releases its key, and allows retry", async () => {
  const write = deferred(); saveFavorite.mockReturnValueOnce(write.promise);
  let first!: Promise<boolean>; let duplicate!: Promise<boolean>;
  await act(async () => {
    first = actions.updateEntry(entry, "favorite", true);
    duplicate = actions.updateEntry(entry, "favorite", true);
  });
  await act(async () => {
    write.reject(new Error("Write failed"));
    expect(await first).toBe(false); expect(await duplicate).toBe(false);
  });
  expect(error).toHaveBeenCalledExactlyOnceWith("Write failed");
  expect(committed).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  expect(actions.isEntryUpdating(entry.id, "favorite")).toBe(false);
  await act(async () => { expect(await actions.updateEntry(entry, "favorite", true)).toBe(true); });
  expect(saveFavorite).toHaveBeenCalledTimes(2);
});

it("continues a queued intent after a rejected or synchronously thrown write", async () => {
  saveRead.mockImplementationOnce(() => { throw new Error("Bridge failed"); });
  let first!: Promise<boolean>; let second!: Promise<boolean>;
  await act(async () => {
    first = actions.updateEntry(entry, "read", true);
    second = actions.updateEntry(entry, "read", false);
    expect(await first).toBe(false); expect(await second).toBe(true);
  });
  expect(committed).toHaveBeenCalledExactlyOnceWith(entry.id, "read", false);
  expect(actions.isEntryUpdating(entry.id, "read")).toBe(false);
});

it("keeps a committed write successful when the read model fails", async () => {
  reload.mockRejectedValue(new Error("List unavailable"));
  await act(async () => { expect(await actions.updateEntry(entry, "favorite", true)).toBe(true); });
  expect(committed).toHaveBeenCalledExactlyOnceWith(entry.id, "favorite", true);
  expect(error).not.toHaveBeenCalled(); expect(saveFavorite).toHaveBeenCalledTimes(1);
  expect(actions.isEntryUpdating(entry.id, "favorite")).toBe(false);
});

it("shares automatic read requests across StrictMode effect replay", async () => {
  const write = deferred(); saveRead.mockReturnValue(write.promise);
  await act(async () => root.render(<StrictMode><Harness autoRead /></StrictMode>));
  expect(saveRead).toHaveBeenCalledExactlyOnceWith(entry.id, true);
  expect(actions.isEntryUpdating(entry.id, "read")).toBe(true);
  await act(async () => write.resolve());
  expect(committed).toHaveBeenCalledTimes(1);
});

it("finishes accepted writes after unmount without updating a replacement owner", async () => {
  const write = deferred(); saveRead.mockReturnValueOnce(write.promise);
  let first!: Promise<boolean>; let second!: Promise<boolean>;
  await act(async () => {
    first = actions.updateEntry(entry, "read", true);
    second = actions.updateEntry(entry, "read", false);
  });
  const oldUpdate = actions.updateEntry;
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness />));
  await act(async () => { write.resolve(); await Promise.all([first, second]); });
  expect(saveRead.mock.calls).toEqual([[entry.id, true], [entry.id, false]]);
  expect(committed).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
  expect(actions.isEntryUpdating(entry.id, "read")).toBe(false);
  expect(await oldUpdate(entry, "read", true)).toBe(false);
  expect(saveRead).toHaveBeenCalledTimes(2);
});

it("captures a queued intent's reporter at admission rather than when its write starts", async () => {
  const firstWrite = deferred(); const secondWrite = deferred();
  const firstError = vi.fn(); const queuedError = vi.fn(); const laterError = vi.fn();
  createErrorReporter.mockReturnValueOnce(firstError).mockReturnValueOnce(queuedError);
  saveRead.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(secondWrite.promise);
  let first!: Promise<boolean>; let second!: Promise<boolean>;
  await act(async () => {
    first = actions.updateEntry(entry, "read", true);
    second = actions.updateEntry(entry, "read", false);
  });
  expect(createErrorReporter).toHaveBeenCalledTimes(2);
  expect(saveRead).toHaveBeenCalledTimes(1);
  createErrorReporter.mockReturnValue(laterError);
  await act(async () => { firstWrite.resolve(); await first; });
  await act(async () => { secondWrite.reject(new Error("Queued failure")); expect(await second).toBe(false); });
  expect(queuedError).toHaveBeenCalledExactlyOnceWith("Queued failure");
  expect(firstError).not.toHaveBeenCalled(); expect(laterError).not.toHaveBeenCalled();
  expect(createErrorReporter).toHaveBeenCalledTimes(2);
});
