// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Timeline, SourceSidebar } from "../src/renderer/library-pane";
import type { Entry, Source } from "../src/shared/types";

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof Timeline>;
const entries = [
  { id: "first", title: "First", read: false, favorite: true },
  { id: "second", title: "Second", read: true, favorite: false }
].map((entry) => ({ ...entry, sourceId: "source", url: `https://example.com/${entry.id}`, canonicalUrl: `https://example.com/${entry.id}`, contentHash: entry.id, createdAt: 1 })) satisfies Entry[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { loadingEntries: false, loadFailed: false, onReload: vi.fn(), onAddSource: vi.fn(), libraryView: "all", entrySearch: "", entries,
    hasMoreEntries: true, loadingMoreEntries: false, sourceById: new Map(), busy: false,
    onClearNotice: vi.fn(), onEntrySearchChange: vi.fn(), onUpdateEntry: vi.fn(async () => true), isEntryUpdating: () => false,
    onOpenEntry: vi.fn(), onDismissEntry: vi.fn(async () => undefined), onRestoreEntry: vi.fn(async () => undefined), onLoadMore: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(update: Partial<typeof props> = {}) { await act(async () => root.render(<Timeline {...props} {...update} />)); }

const source: Source = { id: "source", title: "Source fixture", url: "https://example.com/feed", kind: "rss", status: "error", pollingEnabled: true, consecutiveEmpty: 0, failureCount: 1, createdAt: 1, updatedAt: 1 };

it("separates source status, settings and escaped error details", async () => {
  const edit = vi.fn();
  const activeSource = { ...source, lastError: '<img src="invalid" onerror="alert(1)">\nDiagnostic' };
  await render({ activeSource, onEditSource: edit });
  const status = container.querySelector(".source-health")!;
  expect(status.getAttribute("aria-label")).toBe("来源状态");
  expect(status.querySelector('[role="status"]')?.textContent).toBe("同步失败");
  expect(status.querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
  expect(status.querySelector(".source-health-error")?.textContent).toBe(activeSource.lastError);
  expect(status.querySelector("img")).toBeNull();
  const button = status.querySelector<HTMLButtonElement>("button")!;
  expect(button.textContent).toBe("来源设置");
  await act(async () => button.click()); expect(edit).toHaveBeenCalledExactlyOnceWith(activeSource);
});

it("shows read-only source health without offering an unconfigured settings action", async () => {
  await render({ activeSource: source });
  expect(container.querySelector(".source-health button")).toBeNull();
  expect(container.querySelector(".source-health details")).toBeNull();
  await render(); expect(container.querySelector(".source-health")).toBeNull();
});

it("keeps disclosure for the same source but resets it when navigating to another", async () => {
  await render({ activeSource: { ...source, lastError: "First error" } });
  const details = container.querySelector<HTMLDetailsElement>(".source-health details")!;
  details.open = true;
  await render({ activeSource: { ...source, lastError: "Updated error" } });
  expect(details.open).toBe(true);
  expect(details.textContent).toContain("Updated error");
  await render({ activeSource: { ...source, id: "other", lastError: "Other error" } });
  expect(container.querySelector<HTMLDetailsElement>(".source-health details")!.open).toBe(false);
  expect(container.textContent).not.toContain("Updated error");
});

it("labels the requested read transition and exposes the confirmed favorite state", async () => {
  await render();
  const cards = [...container.querySelectorAll(".entry-card")];
  for (const [index, card] of cards.entries()) {
    const read = [...card.querySelectorAll<HTMLButtonElement>(".entry-actions button")].find((button) => button.textContent?.startsWith("标为"))!;
    const favorite = card.querySelector<HTMLButtonElement>('[aria-label="收藏"]')!;
    expect(read.textContent).toBe(entries[index].read ? "标为未读" : "标为已读");
    expect(favorite.getAttribute("aria-pressed")).toBe(String(entries[index].favorite));
    expect(favorite.title).toBe(entries[index].favorite ? "取消收藏" : "收藏");
    await act(async () => { read.click(); favorite.click(); });
    expect(props.onUpdateEntry).toHaveBeenCalledWith(entries[index], "read", !entries[index].read);
    expect(props.onUpdateEntry).toHaveBeenCalledWith(entries[index], "favorite", !entries[index].favorite);
  }
});

it("disables only the pending card field while keeping reading available", async () => {
  await render({ isEntryUpdating: (id, field) => id === "first" && field === "favorite" });
  const favorites = [...container.querySelectorAll<HTMLButtonElement>('.entry-actions [aria-label="收藏"]')];
  expect(favorites.map((button) => button.disabled)).toEqual([true, false]);
  await act(async () => favorites[0].click());
  expect(props.onUpdateEntry).not.toHaveBeenCalled();
  const open = container.querySelector<HTMLButtonElement>(".entry-actions button")!;
  await act(async () => open.click());
  expect(props.onOpenEntry).toHaveBeenCalledWith(entries[0]);
});

it("offers restoration as a non-destructive action in trash and prevents busy submission", async () => {
  const restore = vi.fn(async () => undefined);
  await render({ libraryView: "trash", onRestoreEntry: restore, busy: true });
  expect(container.querySelector(".delete-entry")).toBeNull();
  expect(container.querySelector('[aria-label="收藏"]')).toBeNull();
  const button = container.querySelector<HTMLButtonElement>(".restore-entry")!;
  expect(button.textContent).toBe("恢复内容");
  await act(async () => button.click()); expect(restore).not.toHaveBeenCalled();
  await render({ libraryView: "trash", onRestoreEntry: restore });
  await act(async () => button.click());
  expect(restore).toHaveBeenCalledWith(entries[0]);
  expect(props.onDismissEntry).not.toHaveBeenCalled();
});

it("routes the same card to the current view's explicit delete or restore command", async () => {
  await render();
  const button = container.querySelector<HTMLButtonElement>(".delete-entry")!;
  await act(async () => button.click());
  expect(props.onDismissEntry).toHaveBeenCalledExactlyOnceWith(entries[0]);
  expect(props.onRestoreEntry).not.toHaveBeenCalled();
  await render({ libraryView: "trash" });
  await act(async () => button.click());
  expect(props.onRestoreEntry).toHaveBeenCalledExactlyOnceWith(entries[0]);
  expect(props.onDismissEntry).toHaveBeenCalledTimes(1);
  await render();
  await act(async () => button.click());
  expect(props.onDismissEntry).toHaveBeenCalledTimes(2);
  expect(props.onRestoreEntry).toHaveBeenCalledTimes(1);
});

it.each(["unread", "favorite"] as const)("counts only visible cards after a committed %s change", async (libraryView) => {
  await render({ libraryView });
  expect(container.querySelectorAll(".entry-card")).toHaveLength(1);
  expect(container.querySelector(".count")?.textContent).toBe("1+ 篇内容");
  expect(container.querySelector(".entry-load-more p")?.textContent).toBe("已显示 1 篇内容");
  await render({ libraryView, hasMoreEntries: false, entrySearch: "First" });
  expect(container.querySelector(".count")?.textContent).toBe("1 篇匹配");
});

it("keeps the next-page action without claiming all matching content is absent", async () => {
  await render({ libraryView: "favorite", entries: [entries[1]] });
  expect(container.querySelector(".count")?.textContent).toBe("0+ 篇内容");
  expect(container.querySelector(".empty-state h2")?.textContent).toBe("还有内容尚未载入");
  expect(container.textContent).not.toContain("还没有收藏文章");
  await act(async () => container.querySelector<HTMLButtonElement>(".entry-load-more button")!.click());
  expect(props.onLoadMore).toHaveBeenCalledOnce();
});

it("disables pagination during a full refresh and re-enables it when ready", async () => {
  await render({ loadingEntries: true });
  const button = container.querySelector<HTMLButtonElement>(".entry-load-more button")!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click()); expect(props.onLoadMore).not.toHaveBeenCalled();
  await render();
  await act(async () => button.click()); expect(props.onLoadMore).toHaveBeenCalledOnce();
});

it("keeps page retry feedback separate from the current undo notice", async () => {
  const undo = vi.fn();
  const paginationError = '<img src="invalid" onerror="alert(1)">';
  await render({ paginationError, notice: "已删除文章", onUndo: undo });
  const error = container.querySelector<HTMLElement>(".entry-pagination-error")!;
  expect(error.textContent).toBe(`暂时无法加载更多：${paginationError}`);
  expect(error.getAttribute("role")).toBe("alert");
  expect(error.tabIndex).toBe(0);
  expect(error.querySelector("img")).toBeNull();
  const retry = container.querySelector<HTMLButtonElement>(".entry-load-more button")!;
  expect(retry.textContent).toBe("重试加载");
  await act(async () => retry.click()); expect(props.onLoadMore).toHaveBeenCalledOnce();
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-actions button")!.click());
  expect(undo).toHaveBeenCalledOnce();
  await render({ paginationError, loadingMoreEntries: true });
  expect(retry.disabled).toBe(true); expect(retry.textContent).toBe("正在加载…");
  await render();
  expect(container.querySelector(".entry-pagination-error")).toBeNull();
  expect(retry.textContent).toBe("加载更多");
});

it("keeps load failure ahead of the incomplete-page explanation", async () => {
  await render({ entries: [entries[1]], libraryView: "favorite", loadFailed: true });
  expect(container.querySelector(".count")?.textContent).toBe("0+ 篇内容");
  expect(container.querySelector(".empty-state h2")?.textContent).toBe("暂时无法载入内容");
  await act(async () => container.querySelector<HTMLButtonElement>(".empty-state button")!.click());
  expect(props.onReload).toHaveBeenCalledOnce();
});

it("shows the final empty-view explanation only when there is no next page", async () => {
  await render({ entries: [entries[1]], libraryView: "favorite", hasMoreEntries: false });
  expect(container.querySelector(".count")?.textContent).toBe("0 篇内容");
  expect(container.querySelector(".empty-state h2")?.textContent).toBe("还没有收藏文章");
  expect(container.querySelector(".entry-load-more")).toBeNull();
});

it("exposes notice text separately from clearly labelled actions", async () => {
  const notice = '<img src="invalid" onerror="alert(1)">\nA long diagnostic';
  const undo = vi.fn();
  await render({ notice, onUndo: undo });
  const message = container.querySelector<HTMLElement>(".notice-message")!;
  expect(message.textContent).toBe(notice);
  expect(message.getAttribute("role")).toBe("status");
  expect(message.tabIndex).toBe(0);
  expect(container.querySelector(".notice img")).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-actions button")!.click());
  expect(undo).toHaveBeenCalledOnce();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!.click());
  expect(props.onClearNotice).toHaveBeenCalledOnce();
});

it("keeps notice dismissal available while an undo is busy", async () => {
  const undo = vi.fn();
  await render({ notice: "Restoring", onUndo: undo, busy: true });
  const retry = container.querySelector<HTMLButtonElement>(".notice-actions button")!;
  const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!;
  expect(retry.disabled).toBe(true); expect(dismiss.disabled).toBe(false);
  await act(async () => { retry.click(); dismiss.click(); });
  expect(undo).not.toHaveBeenCalled(); expect(props.onClearNotice).toHaveBeenCalledOnce();
  await render({ notice: "Another message" });
  expect(container.querySelector(".notice-actions")).toBeNull();
});


it("marks stale sidebar counts as unavailable and restores confirmed values", async () => {
  const sidebar = { sources: [], groups: [], libraryView: "favorite" as const, libraryCounts: { unread: 4, favorite: 1, today: 0, newArrivals: 2 },
    collapsedGroups: {}, onSelectLibrary: vi.fn(), onSelectSource: vi.fn(), onToggleGroup: vi.fn(), onEditSource: vi.fn(), onOpenSettings: vi.fn() };
  await act(async () => root.render(<SourceSidebar {...sidebar} countsStale={false} />));
  expect([...container.querySelectorAll(".library-filter em")].map((item) => item.textContent)).toEqual(["2", "4", "1"]);
  await act(async () => root.render(<SourceSidebar {...sidebar} countsStale />));
  expect([...container.querySelectorAll(".library-filter em")].map((item) => item.textContent)).toEqual(["—", "—", "—"]);
  expect(container.querySelectorAll('[aria-label="计数暂未更新"]')).toHaveLength(3);
  await act(async () => root.render(<SourceSidebar {...sidebar} libraryCounts={{ ...sidebar.libraryCounts, favorite: 0 }} countsStale={false} />));
  expect([...container.querySelectorAll(".library-filter em")].map((item) => item.textContent)).toEqual(["2", "4", "0"]);
  expect(container.querySelector('[aria-label="计数暂未更新"]')).toBeNull();
});
