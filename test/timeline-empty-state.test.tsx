// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelineEmptyState } from "../src/renderer/timeline-empty-state";
import type { LibraryView } from "../src/renderer/library-view";
import type { Source } from "../src/shared/types";

let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof TimelineEmptyState>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { loading: false, failed: false, hasMore: false, hasSources: true, view: "all", search: "", onClearSearch: vi.fn(), onRetry: vi.fn(), onAddSource: vi.fn(), onEditSource: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(update: Partial<typeof props> = {}) { await act(async () => root.render(<TimelineEmptyState {...props} {...update} />)); }

it.each<LibraryView>(["all", "today", "unread", "favorite"])("offers search recovery in the %s view", async (view) => {
  await render({ view, search: "  Missing phrase  " });
  expect(container.querySelector("h2")?.textContent).toBe("没有找到匹配内容");
  expect(container.textContent).toContain("Missing phrase");
  expect(container.textContent).toContain("不会读取或保存文章全文");
  await act(async () => container.querySelector("button")!.click());
  expect(props.onClearSearch).toHaveBeenCalledOnce(); expect(props.onAddSource).not.toHaveBeenCalled();
});

it.each<[LibraryView, string]>([
  ["all", "还没有收集到内容"],
  ["today", "今天还没有内容"], ["unread", "没有未读文章"], ["favorite", "还没有收藏文章"]
])("explains an empty %s view without suggesting a new subscription", async (view, title) => {
  await render({ view });
  expect(container.querySelector("h2")?.textContent).toBe(title);
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).not.toContain("添加 RSS");
});

it("opens the existing add-source flow for a first-time library", async () => {
  await render({ hasSources: false });
  expect(container.querySelector("h2")?.textContent).toBe("添加第一个来源");
  await act(async () => container.querySelector("button")!.click()); expect(props.onAddSource).toHaveBeenCalledOnce();
});

it("links an empty source to its settings", async () => {
  const source = { id: "fixture", title: "Fixture" } as Source;
  await render({ source });
  await act(async () => container.querySelector("button")!.click());
  expect(props.onEditSource).toHaveBeenCalledWith(source);
  await render({ source, search: "missing" });
  expect(container.querySelector("h2")?.textContent).toBe("没有找到匹配内容");
});

it("does not announce a missing source or search result while loading", async () => {
  await render({ loading: true, hasSources: false, search: "missing", failed: true });
  expect(container.querySelector('[role=status]')?.textContent).toContain("正在载入内容");
  expect(container.querySelector("button")).toBeNull();
});

it("offers retry after loading fails instead of claiming the library is empty", async () => {
  await render({ failed: true, hasSources: false, search: "missing" });
  expect(container.querySelector("h2")?.textContent).toBe("暂时无法载入内容");
  await act(async () => container.querySelector("button")!.click()); expect(props.onRetry).toHaveBeenCalledOnce();
});
