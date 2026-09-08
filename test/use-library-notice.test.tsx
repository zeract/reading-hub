// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLibraryNotice } from "../src/renderer/use-library-notice";
import type { Entry } from "../src/shared/types";

const entry = { id: "fixture", title: "Fixture" } as Entry;
let notices: ReturnType<typeof useLibraryNotice>;
let root: Root;
let container: HTMLDivElement;
function Harness() { notices = useLibraryNotice(); return null; }
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("retains undo through a failure without depending on message wording", async () => {
  await act(async () => notices.show("Any deletion message", entry));
  const id = notices.notice!.id;
  await act(async () => notices.updateIfCurrent(id, { message: "Restore failed", undoEntry: entry }));
  expect(notices.notice).toEqual({ id, message: "Restore failed", undoEntry: entry });
  await act(async () => notices.updateIfCurrent(id, { message: "Restored" }));
  expect(notices.notice?.undoEntry).toBeUndefined();
});

it("does not overwrite a newer notice when old undo completes", async () => {
  await act(async () => notices.show("Deleted", entry));
  const id = notices.notice!.id;
  await act(async () => notices.show("A newer operation finished"));
  const current = notices.notice;
  await act(async () => notices.updateIfCurrent(id, { message: "Restored" }));
  expect(notices.notice).toBe(current);
});

it("does not revive a dismissed notice on late success or failure", async () => {
  await act(async () => notices.show("Deleted", entry));
  const id = notices.notice!.id;
  await act(async () => notices.show(undefined));
  await act(async () => notices.updateIfCurrent(id, { message: "Failed", undoEntry: entry }));
  expect(notices.notice).toBeUndefined();
  await act(async () => notices.updateIfCurrent(id, { message: "Restored" }));
  expect(notices.notice).toBeUndefined();
});

it("distinguishes repeated notices for the same entry and text", async () => {
  await act(async () => notices.show("Deleted", entry));
  const id = notices.notice!.id;
  await act(async () => notices.show("Deleted", entry));
  const current = notices.notice;
  expect(current?.id).not.toBe(id);
  await act(async () => notices.updateIfCurrent(id, { message: "Restored" }));
  expect(notices.notice).toBe(current);
});

it("removes an old undo when a normal message replaces it and keeps callbacks stable", async () => {
  const initial = notices;
  await act(async () => notices.show("Deleted", entry));
  await act(async () => notices.show("Refreshed"));
  expect(notices.notice?.undoEntry).toBeUndefined();
  expect(notices.show).toBe(initial.show); expect(notices.updateIfCurrent).toBe(initial.updateIfCurrent);
});
