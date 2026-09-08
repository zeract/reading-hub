// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Timeline, SourceSidebar } from "../src/renderer/library-pane";
import type { Entry } from "../src/shared/types";

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
    onOpenEntry: vi.fn(), onDismissEntry: vi.fn(async () => undefined), onLoadMore: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(update: Partial<typeof props> = {}) { await act(async () => root.render(<Timeline {...props} {...update} />)); }

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
