// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewDialog } from "../src/renderer/source-dialogs";
import type { PendingPreview } from "../src/shared/ipc";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const preview = (token: string): PendingPreview => ({ token, probe: { title: token, url: `https://example.com/${token}`, kind: "rss", confidence: 1, requiresReview: false, preview: [] } });
let root: Root;
let container: HTMLDivElement;
let confirm: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const render = (token = "current", action = confirm) => root.render(<PreviewDialog key={token} pending={preview(token)} onConfirm={action} onCancel={close} />);
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  confirm = vi.fn().mockResolvedValue(undefined);
  close = vi.fn(() => root.render(null));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const save = () => container.querySelector<HTMLButtonElement>(".dialog-actions .primary")!;

it("locks repeated clicks before React commits the disabled state", async () => {
  const request = deferred(); confirm.mockReturnValue(request.promise);
  await act(async () => { save().click(); save().click(); });
  expect(confirm).toHaveBeenCalledOnce(); expect(save().disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("关闭窗口不会中止操作");
  await act(async () => request.resolve());
  expect(save().disabled).toBe(false);
});

it("shows the current failure within the modal and permits retry", async () => {
  confirm.mockRejectedValueOnce(new Error("Synthetic confirmation failure"));
  await act(async () => save().click());
  expect(container.querySelector('.dialog [role="alert"]')?.textContent).toBe("Synthetic confirmation failure");
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  expect(confirm).toHaveBeenCalledTimes(2); expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("clears an earlier error while the retry remains pending", async () => {
  const request = deferred();
  confirm.mockRejectedValueOnce(new Error("First failure")).mockReturnValueOnce(request.promise);
  await act(async () => save().click());
  await act(async () => save().click());
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(save().disabled).toBe(true);
  await act(async () => request.resolve());
});

it("allows closing a pending save without attempting another command", async () => {
  const request = deferred(); confirm.mockReturnValue(request.promise);
  await act(async () => save().click());
  const button = container.querySelector<HTMLButtonElement>(".dialog-actions button:not(.primary)")!;
  expect(button.textContent).toBe("关闭");
  await act(async () => button.click());
  await act(async () => request.resolve());
  expect(close).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
  expect(container.querySelector("dialog")).toBeNull();
});

it("does not expose an old failure or unlock a replacement confirmation", async () => {
  const old = deferred(); const current = deferred();
  confirm.mockReturnValue(old.promise);
  await act(async () => save().click());
  const nextConfirm = vi.fn().mockReturnValue(current.promise);
  await act(async () => render("replacement", nextConfirm));
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  await act(async () => old.reject(new Error("Obsolete failure")));
  expect(save().disabled).toBe(true); expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector(".preview-source-title")?.textContent).toBe("replacement");
  await act(async () => current.resolve());
  expect(nextConfirm).toHaveBeenCalledOnce();
});

it("uses the current callback after a parent rerender without starting a save", async () => {
  const nextConfirm = vi.fn().mockResolvedValue(undefined);
  await act(async () => render("current", nextConfirm));
  expect(confirm).not.toHaveBeenCalled(); expect(nextConfirm).not.toHaveBeenCalled();
  await act(async () => save().click());
  expect(nextConfirm).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
});
