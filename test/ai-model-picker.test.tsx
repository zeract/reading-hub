// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiModelPicker } from "../src/renderer/ai-model-picker";
import type { AiModelCatalog, AiProviderSettings } from "../src/shared/types";
let root: Root;
let container: HTMLDivElement;
let list: ReturnType<typeof vi.fn>;
const codex: AiProviderSettings = { id: "codex-cli", label: "Codex", model: "saved", configured: true, requiresApiKey: false };
const openai: AiProviderSettings = { ...codex, id: "openai", requiresApiKey: true };
function Host({ provider }: { provider: AiProviderSettings }) {
  const [model, setModel] = useState("saved");
  const [effort, setEffort] = useState("high");
  return <AiModelPicker provider={provider} model={model} effort={effort} disabled={false} onModel={setModel} onEffort={setEffort} />;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list = vi.fn();
  Object.defineProperty(window, "reader", { configurable: true, value: { listAiModels: list } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("preserves a saved model on refresh and uses advertised efforts after an explicit model change", async () => {
  list.mockResolvedValue({ models: [{ id: "brand-new", label: "New model", efforts: ["low", "ultra"], defaultEffort: "low" }], stale: false });
  await act(async () => root.render(<Host provider={codex} />));
  const [model, effort] = [...container.querySelectorAll("select")];
  expect(model.value).toBe("saved"); expect(effort.value).toBe("high");
  await act(async () => { model.value = "brand-new"; model.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(effort.value).toBe("default");
  expect([...effort.options].map(option => option.value)).toEqual(["default", "low", "ultra"]);
  list.mockRejectedValueOnce(new Error("private diagnostic"));
  await act(async () => container.querySelector("button")!.click());
  expect(model.value).toBe("brand-new"); expect(container.textContent).not.toContain("private diagnostic");
  expect(container.textContent).toContain("已有选择保持不变");
});
it("ignores an older provider's late response and retains API manual entry", async () => {
  let finish!: (value: AiModelCatalog) => void;
  list.mockImplementation((provider: string) => provider === "codex-cli" ? new Promise(done => { finish = done; }) : Promise.resolve({ models: [{ id: "api-new", label: "API model" }], stale: false }));
  await act(async () => root.render(<Host provider={codex} />));
  await act(async () => root.render(<Host provider={openai} />));
  await act(async () => finish({ models: [{ id: "wrong-provider", label: "Wrong" }], stale: false }));
  expect(container.textContent).not.toContain("wrong-provider");
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "manual-new-model");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("manual-new-model");
  expect(container.querySelector("datalist option")?.getAttribute("value")).toBe("api-new");
});
