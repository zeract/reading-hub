// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationDialog, SourceSettingsDialog } from "../src/renderer/source-dialogs";
import type { CalibrationResult, Source } from "../src/shared/types";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
const source = { id: "fixture", title: "Fixture", url: "https://example.com", kind: "generic", pollingEnabled: true, status: "active" } as Source;
const detected: CalibrationResult = { title: source.title, url: source.url, candidates: [{ label: "Fixture cards", confidence: 0.9, rule: { version: 1, itemRootSelector: "article" }, preview: [] }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let api: {
  calibrateSource: ReturnType<typeof vi.fn>;
  updateRule: ReturnType<typeof vi.fn>;
  refreshSource: ReturnType<typeof vi.fn>;
  getSourceCollectionSettings: ReturnType<typeof vi.fn>;
  updateSourceSettings: ReturnType<typeof vi.fn>;
  updateSourceCollectionScope: ReturnType<typeof vi.fn>;
};
let saved: ReturnType<typeof vi.fn>;
let refresh: ReturnType<typeof vi.fn>;
function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!; }
function submit() { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
async function mount(mode: "settings" | "calibration", key = "first") {
  await act(async () => root.render(mode === "settings"
    ? <SourceSettingsDialog key={key} source={source} onClose={() => root.render(null)} onSaved={saved} onRefresh={refresh} onCalibrate={vi.fn()} onDelete={vi.fn()} onReconnectZhihu={vi.fn()} />
    : <CalibrationDialog key={key} source={source} onClose={() => root.render(null)} onSaved={saved} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api = {
    calibrateSource: vi.fn().mockResolvedValue(detected), updateRule: vi.fn().mockResolvedValue(undefined), refreshSource: vi.fn().mockResolvedValue(undefined),
    getSourceCollectionSettings: vi.fn().mockResolvedValue({ scope: { facetSelections: [], history: { mode: "none" } }, facets: [] }),
    updateSourceSettings: vi.fn().mockResolvedValue(undefined),
    updateSourceCollectionScope: vi.fn().mockImplementation(async (_id, scope) => ({ scope, facets: [] }))
  };
  saved = vi.fn().mockResolvedValue(undefined); refresh = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "reader", { configurable: true, value: api });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("source management request lifetime", () => {
  async function changeScope() {
    api.getSourceCollectionSettings.mockResolvedValue({
      scope: { facetSelections: [], history: { mode: "none" } },
      facets: [{ scheme: "fixture", key: "science", label: "Science", sourceId: source.id, entryCount: 1 }]
    });
    await mount("settings");
    await act(async () => container.querySelector<HTMLInputElement>('.facet-option input')!.click());
  }

  it("retries a failed post-save refresh without repeating the persisted scope change", async () => {
    refresh.mockRejectedValueOnce(new Error("Refresh failed")); await changeScope();
    await act(async () => submit());
    expect(saved).not.toHaveBeenCalled(); expect(container.querySelector('.error')?.textContent).toBe("Refresh failed");
    expect(container.querySelector('[role=status]')?.textContent).toContain("收集范围已保存，刷新尚未完成");
    expect(api.updateSourceCollectionScope).toHaveBeenCalledOnce();
    await act(async () => submit());
    expect(refresh).toHaveBeenCalledTimes(2); expect(saved).toHaveBeenCalledOnce();
    expect(api.updateSourceCollectionScope).toHaveBeenCalledOnce();
    expect(container.querySelector('[role=status]')).toBeNull();
  });

  it("satisfies the pending refresh through the explicit refresh action", async () => {
    refresh.mockRejectedValueOnce(new Error("Refresh failed")); await changeScope();
    await act(async () => submit());
    await act(async () => button("立即刷新").click());
    await act(async () => submit());
    expect(refresh).toHaveBeenCalledTimes(2); expect(saved).toHaveBeenCalledOnce();
    expect(api.updateSourceCollectionScope).toHaveBeenCalledOnce();
  });

  it("does not refresh a persisted scope again after the user disables polling", async () => {
    refresh.mockRejectedValueOnce(new Error("Refresh failed")); await changeScope();
    await act(async () => submit());
    await act(async () => container.querySelector<HTMLInputElement>('.source-settings-toggle input')!.click());
    await act(async () => submit());
    expect(refresh).toHaveBeenCalledOnce(); expect(saved).toHaveBeenCalledOnce();
  });

  it("excludes a second settings save and refresh in the same event batch", async () => {
    const pending = deferred<void>(); api.updateSourceSettings.mockReturnValue(pending.promise);
    await mount("settings");
    await act(async () => { submit(); submit(); button("立即刷新").click(); });
    expect(api.updateSourceSettings).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('.source-settings-body > label input')!.disabled).toBe(true);
    expect(container.querySelector('.dialog-actions .primary')?.textContent).toBe("正在处理…");
    await act(async () => pending.resolve()); expect(saved).toHaveBeenCalledOnce();
  });

  it("excludes settings save while a refresh has started", async () => {
    const pending = deferred<void>(); refresh.mockReturnValue(pending.promise);
    await mount("settings");
    await act(async () => { button("立即刷新").click(); submit(); });
    expect(api.updateSourceSettings).not.toHaveBeenCalled();
    expect(container.querySelector('.dialog-actions .primary')?.textContent).toBe("正在处理…");
    await act(async () => pending.resolve());
  });

  it("keeps settings draft after failure and unlocks retry", async () => {
    api.updateSourceSettings.mockRejectedValueOnce(new Error("Save failed"));
    await mount("settings"); await act(async () => submit());
    expect(container.querySelector(".error")?.textContent).toBe("Save failed");
    expect(container.querySelector("input")?.value).toBe(source.title);
    await act(async () => submit()); expect(saved).toHaveBeenCalledOnce();
  });

  it("saves an accepted rule once and excludes concurrent redetection", async () => {
    const pending = deferred<void>(); api.updateRule.mockReturnValue(pending.promise);
    await mount("calibration");
    await act(async () => { button("这组内容是正确的").click(); button("这组内容是正确的").click(); button("重新自动检测").click(); });
    expect(api.updateRule).toHaveBeenCalledOnce(); expect(api.calibrateSource).toHaveBeenCalledOnce();
    await act(async () => pending.resolve());
    expect(api.refreshSource).toHaveBeenCalledExactlyOnceWith(source.id); expect(saved).toHaveBeenCalledOnce();
  });

  it("does not leave obsolete candidates selectable after redetection fails", async () => {
    await mount("calibration"); api.calibrateSource.mockRejectedValueOnce(new Error("Detection failed"));
    await act(async () => button("重新自动检测").click());
    expect(container.querySelector(".calibration-candidate")).toBeNull();
    expect(container.querySelector(".error")?.textContent).toBe("Detection failed");
    await act(async () => button("重新自动检测").click());
    expect(container.querySelector(".calibration-candidate")).not.toBeNull();
  });

  it("keeps the candidate available to retry a failed rule save", async () => {
    api.updateRule.mockRejectedValueOnce(new Error("Rule failed")); await mount("calibration");
    await act(async () => button("这组内容是正确的").click());
    expect(api.refreshSource).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
    expect(button("这组内容是正确的").disabled).toBe(false);
    await act(async () => button("这组内容是正确的").click()); expect(saved).toHaveBeenCalledOnce();
  });

  it("does not publish a closed detection into a new calibration session", async () => {
    const pending = deferred<CalibrationResult>(); api.calibrateSource.mockReturnValueOnce(pending.promise);
    await mount("calibration"); await mount("calibration", "replacement");
    await act(async () => pending.resolve({ ...detected, candidates: [], message: "Obsolete detection" }));
    expect(container.querySelector(".calibration-candidate")).not.toBeNull();
    expect(container.textContent).not.toContain("Obsolete detection");
  });

  it.each(["settings", "calibration"] as const)("finishes an authorized %s write after closing", async (mode) => {
    const pending = deferred<void>();
    (mode === "settings" ? api.updateSourceSettings : api.updateRule).mockReturnValue(pending.promise);
    await mount(mode);
    await act(async () => mode === "settings" ? submit() : button("这组内容是正确的").click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    await act(async () => pending.resolve());
    expect(saved).toHaveBeenCalledOnce(); expect(container.querySelector("dialog")).toBeNull();
  });
});
