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
  expect(notices.begin).toBe(initial.begin);
});

it("reserves one completion while keeping the current notice visible", async () => {
  await act(async () => notices.show("Existing", entry));
  const existing = notices.notice;
  const publish = notices.begin();
  expect(notices.notice).toBe(existing);
  await act(async () => publish("Refresh completed"));
  expect(notices.notice?.message).toBe("Refresh completed");
  expect(notices.notice?.undoEntry).toBeUndefined();
  await act(async () => publish("Repeated completion"));
  expect(notices.notice?.message).toBe("Refresh completed");
});

it("invalidates pending completion when a notice is shown or dismissed before React renders", async () => {
  await act(async () => {
    const old = notices.begin();
    notices.show("Deleted", entry);
    old("Old completion");
  });
  expect(notices.notice?.undoEntry).toBe(entry);
  await act(async () => {
    const old = notices.begin();
    notices.show(undefined);
    old("Late failure");
  });
  expect(notices.notice).toBeUndefined();
});

it("reserves completion for the latest action even before either action displays a notice", async () => {
  const first = notices.begin(); const second = notices.begin();
  await act(async () => first("Old"));
  expect(notices.notice).toBeUndefined();
  await act(async () => second("Current"));
  expect(notices.notice?.message).toBe("Current");
});

it("treats an explicit clear of an empty notice as invalidation", async () => {
  const publish = notices.begin();
  await act(async () => notices.show(undefined));
  await act(async () => publish("Late"));
  expect(notices.notice).toBeUndefined();
});

it("invalidates a publisher only when an owned notice update actually applies", async () => {
  await act(async () => notices.show("Deleted", entry));
  const id = notices.notice!.id;
  const first = notices.begin();
  await act(async () => notices.updateIfCurrent("obsolete-id", { message: "Ignored" }));
  await act(async () => first("Current"));
  expect(notices.notice?.message).toBe("Current");
  const second = notices.begin();
  await act(async () => notices.updateIfCurrent(notices.notice!.id, { message: "Updated" }));
  await act(async () => second("Late"));
  expect(notices.notice?.message).toBe("Updated");
  expect(notices.notice?.id).not.toBe(id);
});
