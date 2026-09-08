// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderPreferencesProvider, ReaderPreferenceStatus, useReaderPreferences } from "../src/renderer/reader-preferences-context";
import { READER_PREFERENCES_KEY } from "../src/renderer/reader-preferences";

let root: Root;
let container: HTMLDivElement;
let controller: ReturnType<typeof useReaderPreferences>;
let write: ReturnType<typeof vi.spyOn>;
function Consumer() {
  controller = useReaderPreferences();
  return <><output>{controller.preferences.preset}:{controller.preferences.fontScale}</output><ReaderPreferenceStatus /></>;
}
async function render(view = "reader") {
  await act(async () => root.render(<StrictMode><ReaderPreferencesProvider><Consumer key={view} /></ReaderPreferencesProvider></StrictMode>));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  write = vi.spyOn(Storage.prototype, "setItem");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); localStorage.clear(); vi.unstubAllGlobals(); });

it("loads saved preferences without rewriting them on mount, replay or view changes", async () => {
  localStorage.setItem(READER_PREFERENCES_KEY, JSON.stringify({ preset: "compact", fontScale: 1.15 }));
  write.mockClear();
  await render(); await render("settings");
  expect(container.querySelector("output")?.textContent).toBe("compact:1.15");
  expect(write).not.toHaveBeenCalled();
});

it("composes same-event controls synchronously and persists only user changes", async () => {
  await render();
  await act(async () => { controller.setPreset("compact"); controller.adjustFont(0.05); controller.adjustFont(0.05); });
  expect(controller.preferences).toEqual({ preset: "compact", fontScale: 1.1 });
  expect(JSON.parse(localStorage.getItem(READER_PREFERENCES_KEY)!)).toEqual(controller.preferences);
  expect(write).toHaveBeenCalledTimes(3);
  await act(async () => controller.setPreset("compact"));
  expect(write).toHaveBeenCalledTimes(3);
});

it("retains unsaved state and its retry across consumers, then persists the latest choice", async () => {
  write.mockImplementation(() => { throw new DOMException("Sensitive diagnostic", "QuotaExceededError"); });
  await render();
  await act(async () => controller.adjustFont(0.05));
  expect(controller.saveFailed).toBe(true);
  expect(container.textContent).toContain("排版已生效，但尚未保存到本机。");
  expect(container.textContent).not.toContain("Sensitive diagnostic");
  await render("settings");
  expect(controller.preferences.fontScale).toBe(1.05);
  await act(async () => controller.setPreset("compact"));
  await act(async () => container.querySelector<HTMLButtonElement>(".reader-preference-status button")!.click());
  expect(controller.saveFailed).toBe(true);
  write.mockRestore();
  await act(async () => controller.retrySave());
  expect(controller.saveFailed).toBe(false);
  expect(container.querySelector(".reader-preference-status")).toBeNull();
  expect(JSON.parse(localStorage.getItem(READER_PREFERENCES_KEY)!)).toEqual({ preset: "compact", fontScale: 1.05 });
});

it("clears a save failure when the next preference change saves successfully", async () => {
  await render();
  write.mockImplementationOnce(() => { throw new Error("Unavailable"); });
  await act(async () => controller.setPreset("compact"));
  expect(controller.saveFailed).toBe(true);
  await act(async () => controller.adjustFont(0.05));
  expect(controller.saveFailed).toBe(false);
  expect(JSON.parse(localStorage.getItem(READER_PREFERENCES_KEY)!)).toEqual({ preset: "compact", fontScale: 1.05 });
});

it("keeps the existing font boundaries and skips writes at an unchanged boundary", async () => {
  await render();
  await act(async () => controller.adjustFont(10));
  expect(controller.preferences.fontScale).toBe(1.25);
  await act(async () => controller.adjustFont(0.05)); expect(write).toHaveBeenCalledTimes(1);
  await act(async () => controller.adjustFont(-10)); expect(controller.preferences.fontScale).toBe(0.85);
});

it.each(["null", "malformed", '{"preset":"invalid","fontScale":99}'])("falls back safely from invalid saved preferences: %s", async (stored) => {
  localStorage.setItem(READER_PREFERENCES_KEY, stored); write.mockClear();
  await render();
  expect(controller.preferences).toEqual({ preset: "reading", fontScale: 1 });
  expect(write).not.toHaveBeenCalled();
});

it("keeps controls usable when accessing storage itself fails", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
  await render();
  await act(async () => controller.setPreset("compact"));
  expect(controller.preferences.preset).toBe("compact");
  expect(controller.saveFailed).toBe(true);
});
