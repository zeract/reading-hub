// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderPreferencesProvider } from "../src/renderer/reader-preferences-context";
import { ReaderView } from "../src/renderer/reader-view";
import type { AiProviderSettings, Entry } from "../src/shared/types";
const entry: Entry = { id: "fixture", sourceId: "source", url: "https://example.com/article", canonicalUrl: "https://example.com/article", title: "Fixture", read: true, favorite: false, contentHash: "fixture", createdAt: 1 };
const providers: AiProviderSettings[] = [{ id: "openai", label: "Fixture", configured: true, requiresApiKey: true, model: "fixture" }];
let root: Root; let container: HTMLDivElement; let list: ReturnType<typeof vi.fn>; let start: ReturnType<typeof vi.fn>; let settings: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list = vi.fn().mockResolvedValue(providers); start = vi.fn().mockResolvedValue(undefined); settings = vi.fn();
  Object.defineProperty(window, "reader", { configurable: true, value: {
    readEntry: vi.fn(async () => ({ kind: "article", article: { entryId: entry.id, url: entry.url, title: "Fixture", renderProfile: "standard", contentHtml: "<p>Fixture text to translate.</p>" } })),
    cancelEntryRead: vi.fn(async () => undefined), listAiProviders: list,
    onAiStream: vi.fn(() => () => undefined), startAiStream: start, cancelAiStream: vi.fn(async () => undefined)
  } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 700));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ReaderPreferencesProvider><ReaderView favoriteUpdating={false} entry={entry} onUpdateEntry={async () => true} readerOnly={false} onToggleReaderOnly={() => undefined} onOpenSettings={settings} /></ReaderPreferencesProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); getSelection()?.removeAllRanges(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function translate() {
  await act(async () => {
    const paragraph = container.querySelector(".article-body p")!;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    Object.defineProperty(range, "getClientRects", { value: () => [new DOMRect(50, 100, 180, 25)] });
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".reader-selection-toolbar button")].find((button) => button.textContent === "翻译")!.click());
}
async function retry() { await act(async () => container.querySelector<HTMLButtonElement>(".ai-provider-feedback button")!.click()); }
it("recovers failed discovery and starts the original translation only once without article context", async () => {
  list.mockRejectedValueOnce(new Error("Synthetic discovery failure")); await translate();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Synthetic discovery failure");
  expect(container.querySelector(".selection-assistant-settings")).toBeNull(); expect(start).not.toHaveBeenCalled();
  await retry();
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][0].request).toMatchObject({ provider: "openai", selection: { intent: "translate", text: "Fixture text to translate." } });
  expect(start.mock.calls[0][0].request.article).toBeUndefined();
  expect(container.querySelector(".ai-provider-feedback")).toBeNull();
});
it("distinguishes an empty discovery from successfully discovered unconfigured providers", async () => {
  list.mockResolvedValueOnce([]); await translate();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("没有可用的 AI 服务");
  list.mockResolvedValueOnce(providers.map((provider) => ({ ...provider, configured: false })));
  await retry();
  expect(container.querySelector(".ai-provider-feedback")).toBeNull();
  expect(container.querySelector(".selection-assistant-error")?.textContent).toContain("尚未配置");
  await act(async () => container.querySelector<HTMLButtonElement>(".selection-assistant-settings")!.click());
  expect(settings).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled();
});
it("does not start translation when a retry completes after its card closes", async () => {
  list.mockRejectedValueOnce(new Error("Synthetic discovery failure")); await translate();
  let resolve!: (next: AiProviderSettings[]) => void;
  list.mockReturnValueOnce(new Promise<AiProviderSettings[]>((done) => { resolve = done; }));
  await retry();
  expect(container.querySelector('.ai-provider-feedback [role="status"]')?.textContent).toContain("正在读取");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭所选文字回答"]')!.click());
  await act(async () => resolve(providers));
  expect(container.querySelector(".selection-assistant-card")).toBeNull(); expect(start).not.toHaveBeenCalled();
});
