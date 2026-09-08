// @vitest-environment jsdom
import { ReaderPreferencesProvider } from "../src/renderer/reader-preferences-context";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/renderer/settings-view";
import type { AiProviderSettings } from "../src/shared/types";

const providers: AiProviderSettings[] = ["codex-cli", "openai", "deepseek"].map((id) => ({
  id: id as AiProviderSettings["id"], label: id, configured: true, requiresApiKey: id !== "codex-cli", model: "saved-model"
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let list: ReturnType<typeof vi.fn>;
let configure: ReturnType<typeof vi.fn>;
let clear: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list = vi.fn().mockResolvedValue(providers);
  configure = vi.fn().mockResolvedValue(undefined);
  clear = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(window, "reader", { configurable: true, value: { listAiProviders: list, configureAiProvider: configure, clearAiProvider: clear } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ReaderPreferencesProvider><SettingsView onClose={() => undefined} windowFullscreen={false} /></ReaderPreferencesProvider>));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.textContent === "AI 功能")!.click());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function select(value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(".settings-ai-form select")!;
    element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function editModel(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('.settings-ai-form input:not([type="password"])')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
const selected = () => container.querySelector<HTMLSelectElement>(".settings-ai-form select")!.value;

describe("AI settings request lifetime", () => {
  it("keeps a draft intact when selecting a provider instead of rediscovering saved settings", async () => {
    const discovery = deferred<AiProviderSettings[]>(); list.mockReturnValue(discovery.promise);
    await select("openai"); await editModel("draft-model");
    await act(async () => discovery.resolve(providers));
    expect(container.querySelector<HTMLInputElement>('.settings-ai-form input:not([type="password"])')!.value).toBe("draft-model");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("preserves the newest choice when older provider discovery would finish later", async () => {
    const discovery = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(discovery.promise).mockResolvedValue(providers);
    await select("openai"); await select("deepseek");
    await act(async () => discovery.resolve(providers));
    expect(selected()).toBe("deepseek");
  });

  it("admits only one save before React commits the disabled state", async () => {
    const save = deferred<void>(); configure.mockReturnValue(save.promise);
    await act(async () => { submit(); submit(); });
    expect(configure).toHaveBeenCalledTimes(1);
    await act(async () => save.resolve());
  });

  it("does not refresh providers when a save finishes after the settings view closes", async () => {
    const save = deferred<void>(); configure.mockReturnValue(save.promise);
    await act(async () => submit());
    await act(async () => root.render(null));
    await act(async () => save.resolve());
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps edits and permits retry after a current save failure", async () => {
    await select("openai"); await editModel("draft-model");
    configure.mockRejectedValueOnce(new Error("Synthetic save failure"));
    await act(async () => submit());
    expect(container.querySelector(".error")?.textContent).toBe("Synthetic save failure");
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
    await act(async () => submit());
    expect(configure).toHaveBeenLastCalledWith({ provider: "openai", apiKey: "", model: "draft-model", effort: undefined });
    expect(container.querySelector(".error")).toBeNull();
    expect(selected()).toBe("openai");
  });

  it("shares the request lock between clear and save", async () => {
    const operation = deferred<void>(); clear.mockReturnValue(operation.promise);
    await act(async () => { container.querySelector<HTMLButtonElement>(".settings-actions .danger")!.click(); submit(); });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(configure).not.toHaveBeenCalled();
    await act(async () => operation.resolve());
  });

  it("retries only discovery after a committed save fails to refresh", async () => {
    const refresh = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(refresh.promise);
    await act(async () => submit());
    await act(async () => submit());
    expect(configure).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    await act(async () => refresh.reject(new Error("Synthetic refresh failure")));
    expect(container.querySelector(".settings-provider-feedback")?.textContent).toContain("设置操作已完成");
    expect(container.querySelector(".settings-provider-feedback")?.textContent).toContain("Synthetic refresh failure");
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    await act(async () => submit());
    expect(configure).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".settings-provider-feedback button")!.click());
    expect(configure).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".settings-provider-feedback")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
  });

  it("ignores the first mount response after StrictMode restarts discovery", async () => {
    const older = deferred<AiProviderSettings[]>(); const current = deferred<AiProviderSettings[]>();
    list.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    await act(async () => root.render(<StrictMode><ReaderPreferencesProvider><SettingsView onClose={() => undefined} windowFullscreen={false} /></ReaderPreferencesProvider></StrictMode>));
    await act(async () => current.resolve(providers));
    await act(async () => older.resolve(providers.map((provider) => ({ ...provider, label: "Obsolete provider" }))));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.textContent === "AI 功能")!.click());
    expect(container.textContent).not.toContain("Obsolete provider");
    expect(selected()).toBe("codex-cli");
  });

  it("does not refresh or surface an old clear failure in a replacement view", async () => {
    const operation = deferred<void>(); clear.mockReturnValue(operation.promise);
    await act(async () => container.querySelector<HTMLButtonElement>(".settings-actions .danger")!.click());
    await act(async () => root.render(<ReaderPreferencesProvider><SettingsView key="replacement" onClose={() => undefined} windowFullscreen={false} /></ReaderPreferencesProvider>));
    await act(async () => operation.reject(new Error("Obsolete clear failure")));
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Obsolete clear failure");
  });

  it("retains the provider and allows retry after clear fails", async () => {
    await select("openai"); clear.mockRejectedValueOnce(new Error("Synthetic clear failure"));
    await act(async () => container.querySelector<HTMLButtonElement>(".settings-actions .danger")!.click());
    expect(container.querySelector(".error")?.textContent).toBe("Synthetic clear failure");
    expect(selected()).toBe("openai");
    await act(async () => container.querySelector<HTMLButtonElement>(".settings-actions .danger")!.click());
    expect(clear).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenLastCalledWith("openai");
    expect(container.querySelector(".error")).toBeNull();
  });
});

async function reopen() {
  await act(async () => root.render(null));
  await act(async () => root.render(<ReaderPreferencesProvider><SettingsView onClose={() => undefined} windowFullscreen={false} /></ReaderPreferencesProvider>));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("nav button")].find((button) => button.textContent === "AI 功能")!.click());
}

it("shows pending discovery, then permits one read-only retry after startup failure", async () => {
  const discovery = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(discovery.promise);
  await reopen();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("正在读取");
  expect(container.querySelector<HTMLSelectElement>(".settings-ai-form select")!.disabled).toBe(true);
  await act(async () => discovery.reject(new Error("Synthetic discovery failure")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Synthetic discovery failure");
  const retry = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(retry.promise);
  const before = list.mock.calls.length;
  await act(async () => { const button = container.querySelector<HTMLButtonElement>(".settings-provider-feedback button")!; button.click(); button.click(); });
  expect(list).toHaveBeenCalledTimes(before + 1);
  await act(async () => retry.resolve(providers));
  expect(container.querySelector(".settings-provider-feedback")).toBeNull();
  expect(selected()).toBe("codex-cli");
  expect(configure).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
});

it("keeps a committed clear distinct from failed refresh and recovers the selected provider", async () => {
  await select("openai");
  list.mockRejectedValueOnce(new Error("Synthetic clear refresh failure"));
  await act(async () => container.querySelector<HTMLButtonElement>(".settings-actions .danger")!.click());
  expect(clear).toHaveBeenCalledExactlyOnceWith("openai");
  expect(container.querySelector(".settings-provider-feedback")?.textContent).toContain("设置操作已完成");
  list.mockResolvedValueOnce(providers.map((provider) => ({ ...provider, configured: false })));
  await act(async () => container.querySelector<HTMLButtonElement>(".settings-provider-feedback button")!.click());
  expect(selected()).toBe("openai");
  expect(container.querySelector(".settings-actions .danger")).toBeNull();
  expect(clear).toHaveBeenCalledTimes(1);
});

it("treats an empty provider list as recoverable without enabling an unusable form", async () => {
  list.mockResolvedValueOnce([]); await reopen();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("没有可用的 AI 服务");
  expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>(".settings-provider-feedback button")!.click());
  expect(selected()).toBe("codex-cli");
});

it("ignores a discovery retry that resolves after the view is replaced", async () => {
  list.mockRejectedValueOnce(new Error("Synthetic discovery failure")); await reopen();
  const retry = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(retry.promise);
  await act(async () => container.querySelector<HTMLButtonElement>(".settings-provider-feedback button")!.click());
  await reopen();
  await act(async () => retry.resolve(providers.map((provider) => ({ ...provider, label: "Obsolete retry" }))));
  expect(container.textContent).not.toContain("Obsolete retry");
  expect(container.querySelector(".settings-provider-feedback")).toBeNull();
});

it("preserves the committed outcome across failed retries and renders diagnostics as text", async () => {
  list.mockRejectedValueOnce(new Error("First refresh failure"));
  await act(async () => submit());
  list.mockRejectedValueOnce(new Error("<script>synthetic diagnostic</script>"));
  await act(async () => container.querySelector<HTMLButtonElement>(".settings-provider-feedback button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("设置操作已完成");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("<script>synthetic diagnostic</script>");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector<HTMLElement>('[role="alert"]')?.tabIndex).toBe(0);
  expect(configure).toHaveBeenCalledTimes(1);
});
