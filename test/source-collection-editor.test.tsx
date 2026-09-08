// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceSettingsDialog } from "../src/renderer/source-dialogs";
import type { Source, SourceCollectionSettings } from "../src/shared/types";
import { stubDialogPlatform } from "./dialog-platform";
stubDialogPlatform();
const source = { id: "fixture", title: "Fixture", url: "https://example.com", kind: "rss", pollingEnabled: true, status: "active" } as Source;
const selected = { scheme: "feed:fixture", key: "science", label: "Saved science" };
let root: Root; let container: HTMLDivElement; let settings: SourceCollectionSettings; let inspect: ReturnType<typeof vi.fn>; let update: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = { scope: { facetSelections: [selected], history: { mode: "none" } }, facets: [] };
  inspect = vi.fn().mockResolvedValue([]);
  update = vi.fn(async (_id, scope) => ({ ...settings, scope }));
  Object.defineProperty(window, "reader", { configurable: true, value: { getSourceCollectionSettings: vi.fn(async () => settings), inspectSourceCollectionFacets: inspect, updateSourceSettings: vi.fn(async () => undefined), updateSourceCollectionScope: update } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(<SourceSettingsDialog source={source} onClose={() => undefined} onSaved={async () => undefined} onRefresh={async () => undefined} onCalibrate={() => undefined} onDelete={async () => undefined} onReconnectZhihu={async () => undefined} />)); }
const options = () => [...container.querySelectorAll<HTMLLabelElement>(".facet-option")];
function inspectButton() { return container.querySelector<HTMLButtonElement>(".source-collection-scope__heading button"); }
async function save() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
it("keeps saved filters visible and removable when no articles or discovery capability remain", async () => {
  await mount();
  expect(options()).toHaveLength(1); expect(options()[0].textContent).toContain(selected.label);
  expect(options()[0].querySelector("input")!.checked).toBe(true);
  expect(container.textContent).toContain("仍会参与筛选");
  await act(async () => options()[0].querySelector("input")!.click());
  await save();
  expect(update).toHaveBeenCalledExactlyOnceWith(source.id, { facetSelections: [], history: { mode: "none" } });
});
it("allows category discovery independently of historical import and retains absent selections", async () => {
  settings.facetDiscoveryAvailable = true; settings.historyAvailable = false;
  inspect.mockResolvedValue([{ ...selected, scheme: "other:publisher", label: "Other science", sourceId: source.id, entryCount: 3 }]);
  await mount();
  expect(inspectButton()).not.toBeNull(); expect(container.querySelector(".history-options")).toBeNull();
  await act(async () => inspectButton()!.click());
  expect(options()).toHaveLength(2);
  expect(options().find((option) => option.textContent?.includes("Other science"))!.querySelector("input")!.checked).toBe(false);
  expect(options().find((option) => option.textContent?.includes(selected.label))!.querySelector("input")!.checked).toBe(true);
  await save(); expect(update).not.toHaveBeenCalled();
});
it("uses discovered labels and counts without duplicating a saved category identity", async () => {
  settings.facets = [{ ...selected, label: "Current label", sourceId: source.id, entryCount: 4 }];
  await mount();
  expect(options()).toHaveLength(1); expect(options()[0].querySelector("input")!.checked).toBe(true);
  expect(options()[0].textContent).toBe("Current label4 篇");
  expect(options()[0].querySelector("span")!.title).toBe("Current label");
  expect(container.textContent).not.toContain("仍会参与筛选");
  await save(); expect(update).not.toHaveBeenCalled();
});
it("keeps history-only capabilities usable without inventing a category discovery action", async () => {
  settings = { scope: { facetSelections: [], history: { mode: "none" } }, facets: [], historyAvailable: true, facetDiscoveryAvailable: false };
  await mount();
  expect(container.querySelectorAll('.history-options input[type="radio"]')).toHaveLength(3);
  expect(inspectButton()).toBeNull();
  await act(async () => container.querySelectorAll<HTMLInputElement>('.history-options input[type="radio"]')[2].click());
  await save(); expect(update).toHaveBeenCalledExactlyOnceWith(source.id, { facetSelections: [], history: { mode: "all", limit: 100 } });
});
it("clears selected-history mode when the final retained category is removed", async () => {
  settings.scope.history = { mode: "selected", limit: 100 }; settings.historyAvailable = true;
  await mount();
  await act(async () => options()[0].querySelector("input")!.click());
  expect(container.querySelector<HTMLInputElement>('.history-options input[type="radio"]')!.checked).toBe(true);
  await save(); expect(update).toHaveBeenCalledExactlyOnceWith(source.id, { facetSelections: [], history: { mode: "none" } });
});
it("preserves selected categories after failed discovery and keeps the action retryable", async () => {
  settings.facetDiscoveryAvailable = true; inspect.mockRejectedValueOnce(new Error("Synthetic category failure"));
  await mount(); await act(async () => inspectButton()!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Synthetic category failure");
  expect(options()[0].querySelector("input")!.checked).toBe(true);
  await act(async () => inspectButton()!.click());
  expect(inspect).toHaveBeenCalledTimes(2); expect(options()).toHaveLength(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps a retained option available when the user temporarily unchecks it", async () => {
  await mount();
  await act(async () => options()[0].querySelector("input")!.click());
  expect(options()).toHaveLength(1); expect(options()[0].querySelector("input")!.checked).toBe(false);
  expect(container.textContent).not.toContain("仍会参与筛选");
  await act(async () => options()[0].querySelector("input")!.click());
  await save(); expect(update).not.toHaveBeenCalled();
});

it("keeps a newly selected draft category reversible after a later discovery omits it", async () => {
  settings.scope.facetSelections = [];
  settings.facets = [{ ...selected, sourceId: source.id, entryCount: 1 }];
  settings.facetDiscoveryAvailable = true;
  await mount();
  await act(async () => options()[0].querySelector("input")!.click());
  await act(async () => inspectButton()!.click());
  await act(async () => options()[0].querySelector("input")!.click());
  expect(options()).toHaveLength(1); expect(options()[0].querySelector("input")!.checked).toBe(false);
  await act(async () => options()[0].querySelector("input")!.click());
  await save();
  expect(update).toHaveBeenCalledExactlyOnceWith(source.id, { facetSelections: [selected], history: { mode: "none" } });
});
