// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../src/renderer/reader-view";
import type { Entry, ReaderArticle } from "../src/shared/types";
let root: Root;
let container: HTMLDivElement;
const card: Entry = { id: "one", sourceId: "source", url: "https://example.com/one", canonicalUrl: "https://example.com/one", title: "One", contentHash: "hash", read: false, favorite: false, createdAt: 1 };
const article: ReaderArticle = { entryId: card.id, renderProfile: "standard", title: "One", url: card.url, contentHtml: "<p>Loaded article content</p>" };
let update: ReturnType<typeof vi.fn>;
let read: ReturnType<typeof vi.fn>;
async function render(entry = card) {
  await act(async () => root.render(<ReaderView entry={entry} onUpdateEntry={update} readerOnly={false} onToggleReaderOnly={() => undefined} onOpenSettings={() => undefined} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update = vi.fn(async () => true);
  read = vi.fn(async () => ({ kind: "article", article }));
  Object.defineProperty(window, "reader", { configurable: true, value: { readEntry: read } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("successful reading lifecycle", () => {
  it.each(["failure", "embedded"])("leaves %s attempts unread", async (mode) => {
    if (mode === "failure") read.mockRejectedValue(new Error("offline"));
    else read.mockResolvedValue({ kind: "embedded" });
    await render();
    expect(container.querySelector(".reader-article")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
  it("marks once after committing content and respects a subsequent manual unread state", async () => {
    update.mockImplementation(async () => { expect(container.querySelector(".reader-article")).not.toBeNull(); return true; });
    await render();
    expect(update).toHaveBeenCalledExactlyOnceWith(card, "read", true);
    await render({ ...card, read: true });
    await render({ ...card, read: false });
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("discards a delayed article after switching entries", async () => {
    let release!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await render();
    const next = { ...card, id: "two", title: "Two" };
    await render(next);
    await act(async () => release({ kind: "article", article: { ...article, title: "stale" } }));
    expect(update).toHaveBeenCalledExactlyOnceWith(next, "read", true);
    expect(container.textContent).not.toContain("stale");
  });
});
