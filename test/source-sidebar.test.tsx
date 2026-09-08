// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceSidebar } from "../src/renderer/library-pane";
import { groupSources } from "../src/renderer/source-groups";
import type { Source } from "../src/shared/types";

const sources: Source[] = [true, false].map((subscribed, index) => ({ id: `source-${index}`, title: `Source ${index}`, url: `https://example.com/${index}`, kind: "rss", status: "active", pollingEnabled: true, subscribed, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1 }));
let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof SourceSidebar>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "reader", { configurable: true, value: { loadSourceIcon: vi.fn(async () => undefined) } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { sources, groups: groupSources(sources), libraryView: "all", libraryCounts: { unread: 2, favorite: 1, today: 0, newArrivals: 0 }, countsStale: false,
    collapsedGroups: {}, onSelectLibrary: vi.fn(), onSelectSource: vi.fn(), onToggleGroup: vi.fn(), onEditSource: vi.fn(), onOpenSettings: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(update: Partial<typeof props> = {}) { await act(async () => root.render(<SourceSidebar {...props} {...update} />)); }

it("exposes only the current library or source, including archived sources", async () => {
  await render();
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("全部内容");
  await render({ activeSourceId: sources[0].id });
  expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(container.querySelector('[aria-current="page"] .source-title')?.textContent).toBe(sources[0].title);
  await render({ activeSourceId: sources[1].id });
  expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(container.querySelector('.archived-sources [aria-current="page"] .source-title')?.textContent).toBe(sources[1].title);
  await render({ libraryView: "trash" });
  expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("最近删除");
});

it.each([0, 1])("offers the same context-menu and keyboard settings on source %s", async (index) => {
  await render();
  const button = [...container.querySelectorAll<HTMLButtonElement>(".source-filter")][index];
  await act(async () => button.click());
  expect(props.onSelectSource).toHaveBeenCalledExactlyOnceWith(sources[index].id);
  for (const event of [new MouseEvent("contextmenu", { bubbles: true, cancelable: true }), new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }), new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })]) {
    await act(async () => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  }
  expect(props.onEditSource).toHaveBeenCalledTimes(3);
  expect(props.onEditSource).toHaveBeenLastCalledWith(sources[index]);
  expect(props.onSelectSource).toHaveBeenCalledTimes(1);
});

it("labels the archived shortcut as opening settings rather than resubscribing", async () => {
  await render();
  const button = container.querySelector<HTMLButtonElement>(".archived-sources .source-settings-shortcut")!;
  expect(button?.getAttribute("aria-label")).toBe(`打开 ${sources[1].title} 的来源设置`);
  await act(async () => button.click());
  expect(props.onEditSource).toHaveBeenCalledExactlyOnceWith(sources[1]);
  expect(props.onSelectSource).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label^="重新订阅"]')).toBeNull();
});

it("keeps navigation counts, click routing and subscribed totals unchanged", async () => {
  await render();
  expect([...container.querySelectorAll('.library-filter em')].map((element) => element.textContent)).toEqual(["", "2", "1"]);
  expect(container.querySelector('#source-heading span')?.textContent).toBe("1");
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(".library-filter")];
  await act(async () => { for (const button of buttons) button.click(); });
  expect(vi.mocked(props.onSelectLibrary).mock.calls.flat()).toEqual(["collected", "all", "today", "unread", "favorite", "history", "trash"]);
});
