// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModalSurface } from "../src/renderer/modal-surface";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const view = (onClose: () => void, dismissOnBackdrop = false) => <ModalSurface title="Fixture dialog" className="fixture" onClose={onClose} dismissOnBackdrop={dismissOnBackdrop}><button>Inside</button></ModalSurface>;

it("opens through StrictMode effect replay and closes before removal", async () => {
  await act(async () => root.render(<StrictMode>{view(vi.fn())}</StrictMode>));
  const dialog = container.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  await act(async () => root.render(null));
  expect(dialog.open).toBe(false);
});

it("routes native cancellation to the current owner without closing behind React", async () => {
  const oldClose = vi.fn(); const close = vi.fn();
  await act(async () => root.render(view(oldClose)));
  await act(async () => root.render(view(close)));
  const event = new Event("cancel", { cancelable: true });
  await act(async () => container.querySelector("dialog")!.dispatchEvent(event));
  expect(close).toHaveBeenCalledOnce(); expect(oldClose).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
  expect(container.querySelector("dialog")!.open).toBe(true);
});

it("only dismisses backdrop clicks for surfaces that opt in", async () => {
  const close = vi.fn();
  await act(async () => root.render(view(close)));
  await act(async () => container.querySelector("dialog")!.click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => root.render(view(close, true)));
  await act(async () => container.querySelector("button")!.click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => container.querySelector("dialog")!.click());
  expect(close).toHaveBeenCalledOnce();
});
