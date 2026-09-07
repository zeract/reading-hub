// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../src/renderer/reader-view";
import type { Entry, ReaderArticle } from "../src/shared/types";
const card: Entry = { id: "one", sourceId: "source", url: "https://example.com/one", canonicalUrl: "https://example.com/one", title: "One", contentHash: "hash", read: true, favorite: false, createdAt: 1 };
let root: Root, container: HTMLDivElement;
let load: ReturnType<typeof vi.fn>, cancel: ReturnType<typeof vi.fn>;
async function render(id = "one") {
  await act(async () => root.render(<StrictMode><ReaderView entry={{ ...card, id }} onUpdateEntry={async () => true} readerOnly={false} onToggleReaderOnly={() => undefined} onOpenSettings={() => undefined} /></StrictMode>));
}
async function failImage(selector = ".reader-cover"): Promise<HTMLImageElement> {
  const image = container.querySelector<HTMLImageElement>(selector)!;
  await act(async () => image.dispatchEvent(new Event("error", { bubbles: false })));
  return image;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  load = vi.fn(); cancel = vi.fn(async () => undefined);
  Object.defineProperty(window, "reader", { configurable: true, value: {
    readEntry: vi.fn(async (id: string) => ({ kind: "article", article: { entryId: id, title: id, url: card.url, renderProfile: "standard", coverImageUrl: "https://example.com/cover.png", contentHtml: `<p>fixture</p><img src="https://example.com/${id}.png">` } })),
    loadArticleImage: load, cancelArticleImage: cancel, cancelEntryRead: vi.fn(async () => undefined)
  } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("reader image lifetime", () => {
  it("handles a native non-bubbling image error from sanitized HTML", async () => {
    load.mockResolvedValue("data:image/png;base64,Zml4dHVyZQ==");
    await render(); await failImage(".article-body img");
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("cancels pending image requests when switching articles", async () => {
    load.mockImplementation(() => new Promise<string>(() => undefined));
    await render(); await failImage(); await render("two");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not assign a late image response to the detached previous article", async () => {
    let finish!: (value: string) => void;
    load.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render(); const old = await failImage(); const original = old.src;
    await render("two");
    await act(async () => finish("data:image/png;base64,Zml4dHVyZQ=="));
    expect(old.src).toBe(original);
  });

  it("cancels both cover and body requests on unmount and observes cancellation IPC failures", async () => {
    load.mockImplementation(() => new Promise<string>(() => undefined));
    cancel.mockRejectedValue(new Error("fixture IPC closing"));
    await render(); await failImage(); await failImage(".article-body img");
    const ids = load.mock.calls.map((args) => args[2]);
    expect(new Set(ids).size).toBe(2);
    await act(async () => root.render(null));
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(ids);
  });

  it("keeps current image work on an unrelated font/layout update", async () => {
    load.mockImplementation(() => new Promise<string>(() => undefined));
    await render(); const image = await failImage(".article-body img");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="放大字号"]')!.click());
    expect(cancel).not.toHaveBeenCalled();
    expect(container.querySelector(".article-body img")).toBe(image);
  });

  it("does not cancel completed requests or retry the failed proxy recursively", async () => {
    load.mockResolvedValue("data:image/png;base64,Zml4dHVyZQ==");
    await render(); const image = await failImage(".article-body img");
    expect(image.src).toBe("data:image/png;base64,Zml4dHVyZQ==");
    await act(async () => image.dispatchEvent(new Event("error")));
    const link = container.querySelector<HTMLAnchorElement>(".reader-image-failure")!;
    expect(link.href).toBe(card.url);
    expect(load).toHaveBeenCalledTimes(1);
    await render("two"); expect(cancel).not.toHaveBeenCalled();
  });

  it("ignores late errors without replacing a new article's image", async () => {
    let fail!: (reason: Error) => void;
    load.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    await render(); await failImage(); await render("two");
    await act(async () => fail(new Error("old failed")));
    expect(container.querySelector(".reader-cover")).not.toBeNull();
    expect(container.querySelector(".reader-image-failure")).toBeNull();
  });

  it("cancels old language images and gives identical HTML a fresh document lifecycle", async () => {
    const first: ReaderArticle = { entryId: "one", title: "one", url: card.url, renderProfile: "standard", contentHtml: '<img src="https://example.com/shared.png">', languageVariants: [
      { language: "en", label: "English", url: card.url }, { language: "zh", label: "中文", url: "https://example.com/zh" }
    ] };
    vi.mocked(window.reader.readEntry).mockResolvedValue({ kind: "article", article: first });
    window.reader.readEntryLanguageVariant = vi.fn(async () => ({ ...first, url: "https://example.com/zh" }));
    load.mockImplementation(() => new Promise<string>(() => undefined));
    await render(); const old = await failImage(".article-body img");
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".reader-language-switcher button")).find((button) => button.textContent === "中文")!.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    const next = await failImage(".article-body img");
    expect(next).not.toBe(old);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[0][2]).not.toBe(load.mock.calls[1][2]);
  });
});
