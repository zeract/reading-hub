// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSourceDialog } from "../src/renderer/source-dialogs";
import type { PendingPreview } from "../src/shared/ipc";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
let root: Root;
let container: HTMLDivElement;
let preview: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
const dialog = () => <AddSourceDialog onClose={vi.fn()} onPreview={publish} onImportOpml={vi.fn()} onZhihuStarted={vi.fn()} onXStarted={vi.fn()} onXiaohongshuSaved={vi.fn()} onAcademicSaved={vi.fn()} />;
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const panel = () => container.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
async function key(value: string, modifiers = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...modifiers });
  await act(async () => document.activeElement!.dispatchEvent(event));
  return event;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preview = vi.fn(); publish = vi.fn();
  Object.defineProperty(window, "reader", { configurable: true, value: { previewSource: preview } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(dialog()));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("source method navigation", () => {
  it("links every tab to a labelled panel while mounting only the selected form", () => {
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    for (const tab of tabs()) {
      const target = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(target?.getAttribute("role")).toBe("tabpanel");
      expect(target?.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(target?.hidden).toBe(tab.getAttribute("aria-selected") !== "true");
    }
    expect(panel().tabIndex).toBe(0);
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelector("#academic-query")).toBeNull();
  });

  it("moves and wraps focus without activating a different source method", async () => {
    await act(async () => tabs()[0].focus());
    expect((await key("ArrowLeft")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tabs()[4]);
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toEqual([tabs()[4]]);
    await key("ArrowRight"); expect(document.activeElement).toBe(tabs()[0]);
    await key("End"); expect(document.activeElement).toBe(tabs()[4]);
    await key("Home"); expect(document.activeElement).toBe(tabs()[0]);
    expect((await key("ArrowDown")).defaultPrevented).toBe(false);
    expect((await key("ArrowRight", { altKey: true })).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("returns the selected method to the Tab sequence after focus leaves the list", async () => {
    await act(async () => tabs()[2].click());
    await act(async () => tabs()[2].focus());
    await key("ArrowLeft");
    expect(document.activeElement).toBe(tabs()[1]);
    await act(async () => panel().focus());
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toEqual([tabs()[2]]);
    expect(tabs()[2].getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the selector open when returning to the public method", async () => {
    await act(async () => tabs()[4].click());
    expect(container.querySelector("details")!.open).toBe(true);
    await act(async () => tabs()[0].click());
    expect(container.querySelector("details")!.open).toBe(true);
    expect(panel().contains(container.querySelector("#source-url"))).toBe(true);
    expect(container.querySelector("#academic-query")).toBeNull();
  });

  it("preserves the current probe and draft while navigating unselected tabs", async () => {
    let resolve!: (result: PendingPreview) => void;
    preview.mockReturnValueOnce(new Promise<PendingPreview>((done) => { resolve = done; }));
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("#source-url")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.com/feed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => tabs()[0].focus()); await key("End");
    expect(document.activeElement).toBe(tabs()[4]);
    expect(container.querySelector<HTMLInputElement>("#source-url")!.value).toBe("https://example.com/feed");
    const result = { token: "current" } as PendingPreview;
    await act(async () => resolve(result));
    expect(publish).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("uses independent tab and panel identities for separate dialog instances", async () => {
    await act(async () => root.render(<>{dialog()}{dialog()}</>));
    const identified = [...container.querySelectorAll('[role="tab"], [role="tabpanel"]')];
    expect(identified).toHaveLength(20);
    expect(new Set(identified.map((element) => element.id)).size).toBe(20);
  });
});
