// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import type { ReaderApi } from "../src/shared/ipc";
import type { Source } from "../src/shared/types";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
let root: Root; let container: HTMLDivElement; let source: Source;
let pages: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  source = { id: "fixture", title: "Fixture source", url: "https://example.com/feed", kind: "rss", status: "active", subscribed: true, pollingEnabled: true, failureCount: 0, consecutiveEmpty: 0, createdAt: 1, updatedAt: 1 };
  pages = vi.fn(async () => ({ entries: [] }));
  Object.defineProperty(window, "reader", { configurable: true, value: {
    getLibraryRevision: vi.fn(async () => 1), listSources: vi.fn(async () => source.subscribed ? [{ ...source }] : []), listEntryPage: pages,
    getLibraryCounts: vi.fn(async () => ({ unread: 0, favorite: 0, today: 0 })), onLibraryChanged: () => () => undefined,
    isWindowFullscreen: vi.fn(async () => false), onWindowFullscreenChange: () => () => undefined,
    loadSourceIcon: vi.fn(async () => undefined),
    refreshSource: vi.fn(async () => ({ inserted: 0, source: { ...source } })),
    updateSourceSettings: vi.fn(async () => ({ ...source })),
    updateSourceCollectionScope: vi.fn(async (_id, scope) => ({ scope, facets: [] })),
    getSourceCollectionSettings: vi.fn(async () => ({ scope: { facetSelections: [], history: { mode: "none" as const } }, facets: [] })),
    deleteSource: vi.fn(async (_id: string) => { source.subscribed = false; }),
    importOpml: vi.fn(async () => ({ imported: 2, existing: 1, skipped: 1, cancelled: false }))
  } satisfies Partial<ReaderApi> });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<App />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); }
async function clickText(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
async function openSettings() {
  await act(async () => container.querySelector(".source-filter")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
}

it.each([true])("keeps a committed subscription change successful when list recovery fails (subscribed=%s)", async (subscribed) => {
  source.subscribed = subscribed;
  await click('[aria-label="重新载入收件箱"]');
  await openSettings();
  pages.mockRejectedValue(new Error("Synthetic list failure"));
  await clickText(subscribed ? "取消订阅" : "重新订阅");
  expect(source.subscribed).toBe(!subscribed);
  expect(container.querySelector(".source-settings-form")).toBeNull();
  expect(container.querySelector(".notice")?.textContent).toContain("Synthetic list failure");
  pages.mockResolvedValue({ entries: [] });
  await click('[aria-label="重新载入收件箱"]');
  expect(window.reader.deleteSource).toHaveBeenCalledExactlyOnceWith(source.id);
  expect(container.querySelector(".archived-sources")).toBeNull();
  expect(container.querySelector(".source-filter")).toBeNull();
});

it("keeps a failed subscription change in its dialog for retry", async () => {
  await openSettings();
  vi.mocked(window.reader.deleteSource).mockRejectedValueOnce(new Error("Synthetic write failure"));
  const reads = pages.mock.calls.length;
  await clickText("取消订阅");
  expect(container.querySelector(".source-settings-form [role=alert]")?.textContent).toBe("Synthetic write failure");
  expect(source.subscribed).toBe(true); expect(pages).toHaveBeenCalledTimes(reads);
  await clickText("取消订阅");
  expect(container.querySelector(".source-settings-form")).toBeNull();
  expect(window.reader.deleteSource).toHaveBeenCalledTimes(2);
});

it("returns import counts even when the subsequent library read fails", async () => {
  await click('[aria-label="添加来源"]');
  pages.mockRejectedValue(new Error("Synthetic list failure"));
  await clickText("导入 OPML…");
  expect(container.querySelector(".connector-form [role=status]")?.textContent).toBe("已导入 2 个 Feed；1 个已存在；跳过 1 个。");
  expect(container.querySelector(".connector-form [role=alert]")).toBeNull();
  expect(container.querySelector(".notice")?.textContent).toContain("Synthetic list failure");
  await click('.dialog [aria-label="关闭"]');
  pages.mockResolvedValue({ entries: [] });
  await click('[aria-label="重新载入收件箱"]');
  expect(window.reader.importOpml).toHaveBeenCalledTimes(1);
});

it.each(["cancelled", "failed"])("does not reload after an import is %s", async (outcome) => {
  await click('[aria-label="添加来源"]');
  if (outcome === "cancelled") vi.mocked(window.reader.importOpml).mockResolvedValueOnce({ imported: 0, existing: 0, skipped: 0, cancelled: true });
  else vi.mocked(window.reader.importOpml).mockRejectedValueOnce(new Error("Synthetic import failure"));
  const reads = pages.mock.calls.length;
  await clickText("导入 OPML…");
  expect(pages).toHaveBeenCalledTimes(reads);
  expect(container.querySelector(".connector-form [role=status]")).toBeNull();
  if (outcome === "failed") expect(container.querySelector(".connector-form [role=alert]")?.textContent).toContain("Synthetic import failure");
  else expect(container.querySelector(".connector-form [role=alert]")).toBeNull();
});

it("does not report a completed source refresh as failed or silently repeat a failed list read", async () => {
  await openSettings();
  const reads = pages.mock.calls.length;
  pages.mockRejectedValue(new Error("Synthetic list failure"));
  await clickText("立即刷新");
  expect(container.querySelector(".source-settings-form [role=alert]")).toBeNull();
  expect(pages).toHaveBeenCalledTimes(reads + 1);
  expect(container.querySelector(".notice")?.textContent).toContain("Synthetic list failure");
  await click('.dialog [aria-label="关闭"]');
  pages.mockResolvedValue({ entries: [] });
  await click('[aria-label="重新载入收件箱"]');
  expect(window.reader.refreshSource).toHaveBeenCalledExactlyOnceWith(source.id);
});

it("keeps the actual refresh error when reading its updated source state also fails", async () => {
  await openSettings();
  vi.mocked(window.reader.refreshSource).mockRejectedValueOnce(new Error("Synthetic refresh failure"));
  pages.mockRejectedValue(new Error("Synthetic list failure"));
  const reads = pages.mock.calls.length;
  await clickText("立即刷新");
  expect(container.querySelector(".source-settings-form [role=alert]")?.textContent).toBe("Synthetic refresh failure");
  expect(pages).toHaveBeenCalledTimes(reads + 1);
  pages.mockResolvedValue({ entries: [] });
  await clickText("立即刷新");
  expect(container.querySelector(".source-settings-form [role=alert]")).toBeNull();
  expect(window.reader.refreshSource).toHaveBeenCalledTimes(2);
});

it("finishes a saved scope after its successful refresh even if list recovery fails", async () => {
  vi.mocked(window.reader.getSourceCollectionSettings).mockResolvedValueOnce({
    scope: { facetSelections: [], history: { mode: "none" } },
    facets: [{ scheme: "fixture", key: "science", label: "Science", sourceId: source.id, entryCount: 1 }]
  });
  await openSettings();
  await click('.facet-option input');
  pages.mockRejectedValue(new Error("Synthetic list failure"));
  await act(async () => container.querySelector(".source-settings-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(window.reader.updateSourceCollectionScope).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".source-settings-form")).toBeNull();
  expect(container.querySelector(".notice")?.textContent).toContain("Synthetic list failure");
  pages.mockResolvedValue({ entries: [] });
  await click('[aria-label="重新载入收件箱"]');
  expect(window.reader.updateSourceCollectionScope).toHaveBeenCalledTimes(1);
  expect(window.reader.refreshSource).toHaveBeenCalledTimes(1);
});
