// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AddSourceDialog } from "../src/renderer/source-dialogs";
import type { PendingPreview } from "../src/shared/ipc";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const result = (token: string): PendingPreview => ({ token, probe: { title: token, url: `https://example.com/${token}`, kind: "rss", confidence: 1, requiresReview: false, preview: [] } });
let root: Root;
let container: HTMLDivElement;
let preview: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let importOpml: ReturnType<typeof vi.fn>;
const mount = () => root.render(<AddSourceDialog onClose={() => root.render(null)} onPreview={publish} onImportOpml={importOpml} onZhihuStarted={async () => undefined} onXStarted={async () => undefined} onXiaohongshuSaved={async () => undefined} onAcademicSaved={async () => undefined} />);
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preview = vi.fn(); publish = vi.fn(); importOpml = vi.fn();
  Object.defineProperty(window, "reader", { configurable: true, value: { previewSource: preview } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => mount());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function edit(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("#source-url")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
const submitButton = () => container.querySelector<HTMLButtonElement>(".dialog-actions .primary")!;

it("publishes only a successfully resolved current probe", async () => {
  const request = deferred<PendingPreview>(); preview.mockReturnValue(request.promise);
  await edit("https://example.com/current"); await act(async () => submit());
  expect(publish).not.toHaveBeenCalled(); expect(submitButton().disabled).toBe(true);
  await act(async () => request.resolve(result("current")));
  expect(publish).toHaveBeenCalledExactlyOnceWith(result("current"));
});

it("does not publish after the dialog closes and reopens", async () => {
  const request = deferred<PendingPreview>(); preview.mockReturnValue(request.promise);
  await edit("https://example.com/old"); await act(async () => submit());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
  await act(async () => mount());
  await act(async () => request.resolve(result("old")));
  expect(publish).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>("#source-url")!.value).toBe("");
});

it("does not publish after switching to another source method", async () => {
  const request = deferred<PendingPreview>(); preview.mockReturnValue(request.promise);
  await edit("https://example.com/old"); await act(async () => submit());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === "学术作者")!.click());
  await act(async () => request.resolve(result("old")));
  expect(publish).not.toHaveBeenCalled();
  expect(container.querySelector("#academic-query")).not.toBeNull();
});

it("invalidates a closing form before a queued completion runs", async () => {
  const request = deferred<PendingPreview>(); preview.mockReturnValue(request.promise);
  await edit("https://example.com/old"); await act(async () => submit());
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
    request.resolve(result("old"));
    await Promise.resolve();
  });
  expect(publish).not.toHaveBeenCalled();
});

it("invalidates at URL edit time and keeps a newer probe busy when the old one settles", async () => {
  const old = deferred<PendingPreview>(); const current = deferred<PendingPreview>();
  preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await edit("https://example.com/old"); await act(async () => submit());
  await edit("https://example.com/current"); await act(async () => submit());
  await act(async () => old.resolve(result("old")));
  expect(publish).not.toHaveBeenCalled(); expect(submitButton().disabled).toBe(true);
  await act(async () => current.resolve(result("current")));
  expect(publish).toHaveBeenCalledExactlyOnceWith(result("current"));
});

it("ignores stale failures but displays a current failure and allows retry", async () => {
  const old = deferred<PendingPreview>(); const current = deferred<PendingPreview>();
  preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue(result("retry"));
  await edit("https://example.com/old"); await act(async () => submit());
  await edit("https://example.com/current"); await act(async () => submit());
  await act(async () => old.reject(new Error("Obsolete failure")));
  expect(container.querySelector(".error")).toBeNull(); expect(submitButton().disabled).toBe(true);
  await act(async () => current.reject(new Error("Current failure")));
  expect(container.querySelector(".error")?.textContent).toBe("Current failure");
  await act(async () => submit());
  expect(publish).toHaveBeenCalledExactlyOnceWith(result("retry"));
});

it("locks duplicate submissions before React disables the button", async () => {
  const request = deferred<PendingPreview>(); preview.mockReturnValue(request.promise);
  await edit("https://example.com/current"); await act(async () => { submit(); submit(); });
  expect(preview).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve(result("current")));
});

it("does not overlap probing with OPML import, even if the URL is edited", async () => {
  const request = deferred<{ cancelled: boolean }>(); importOpml.mockReturnValue(request.promise);
  await act(async () => container.querySelector<HTMLButtonElement>('.dialog-actions button[type="button"]')!.click());
  await edit("https://example.com/current"); await act(async () => submit());
  expect(preview).not.toHaveBeenCalled(); expect(submitButton().disabled).toBe(true);
  await act(async () => request.resolve({ cancelled: true }));
  expect(submitButton().disabled).toBe(false);
});

it("does not start a request for an empty URL", async () => {
  await act(async () => submit());
  expect(preview).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});
