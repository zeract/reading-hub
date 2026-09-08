// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import type { ReaderApi } from "../src/shared/ipc";
import type { Entry, EntryPage, Source } from "../src/shared/types";

const source: Source = { id: "source", url: "https://example.com/feed", title: "Fixture source", kind: "rss", status: "active", pollingEnabled: true, failureCount: 0, consecutiveEmpty: 0, createdAt: 1, updatedAt: 1 };
const entry: Entry = { id: "entry", sourceId: source.id, url: "https://example.com/article", canonicalUrl: "https://example.com/article", title: "Fixture entry", contentHash: "fixture", createdAt: 1, read: false, favorite: true };
let root: Root; let container: HTMLDivElement; let pages: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let deleted = false;
  pages = vi.fn(async () => ({ entries: deleted ? [] : [entry] }));
  Object.defineProperty(window, "reader", { configurable: true, value: {
    getLibraryRevision: vi.fn(async () => 1), listSources: vi.fn(async () => [source]), listEntryPage: pages,
    getLibraryCounts: vi.fn(async () => ({ unread: 1, favorite: 1, today: 0 })), onLibraryChanged: () => () => undefined,
    isWindowFullscreen: vi.fn(async () => false), onWindowFullscreenChange: () => () => undefined,
    loadSourceIcon: vi.fn(async () => undefined), dismissEntry: vi.fn(async () => { deleted = true; })
  } satisfies Partial<ReaderApi> });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<App />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); }
function deferPage() {
  let resolve!: (page: EntryPage) => void;
  pages.mockReturnValueOnce(new Promise<EntryPage>((done) => { resolve = done; }));
  return () => resolve({ entries: [entry] });
}

it.each([false, true])("does not overwrite or revive a newer deletion notice after old refresh (dismissed=%s)", async (dismissed) => {
  const complete = deferPage();
  await click('[aria-label="重新载入收件箱"]');
  await click(".delete-entry");
  expect(container.querySelector(".notice-actions")?.textContent).toContain("撤销删除");
  const notice = container.querySelector(".notice-message")!.textContent;
  if (dismissed) await click('[aria-label="关闭通知"]');
  await act(async () => complete());
  if (dismissed) expect(container.querySelector(".notice")).toBeNull();
  else {
    expect(container.querySelector(".notice-message")?.textContent).toBe(notice);
    expect(container.querySelector(".notice-actions")?.textContent).toContain("撤销删除");
  }
});

it("does not let an older refresh revive the dismissed result of a newer refresh", async () => {
  const first = deferPage(); await click('[aria-label="重新载入收件箱"]');
  const second = deferPage(); await click('[aria-label="重新载入收件箱"]');
  await act(async () => second());
  expect(container.querySelector(".notice-message")?.textContent).toBe("已重新载入收件箱。");
  await click('[aria-label="关闭通知"]');
  await act(async () => first());
  expect(container.querySelector(".notice")).toBeNull();
});
