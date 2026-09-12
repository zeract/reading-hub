// @vitest-environment jsdom
import { ReaderPreferencesProvider } from "../src/renderer/reader-preferences-context";
import { act, StrictMode } from "react";
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
let cancelRead: ReturnType<typeof vi.fn>;
async function render(entry = card, strict = false) {
  const view = <ReaderPreferencesProvider><ReaderView favoriteUpdating={false} entry={entry} onUpdateEntry={update} readerOnly={false} onToggleReaderOnly={() => undefined} onOpenSettings={() => undefined} /></ReaderPreferencesProvider>;
  await act(async () => root.render(strict ? <StrictMode>{view}</StrictMode> : view));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update = vi.fn(async () => true);
  read = vi.fn(async () => ({ kind: "article", article }));
  cancelRead = vi.fn(async () => undefined);
  Object.defineProperty(window, "reader", { configurable: true, value: { readEntry: read, cancelEntryRead: cancelRead } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("successful reading lifecycle", () => {
  it("cancels pending extraction when another entry replaces the view", async () => {
    read.mockImplementationOnce(() => new Promise(() => undefined));
    await render(); await render({ ...card, id: "two" });
    expect(cancelRead).toHaveBeenCalledTimes(1);
    expect(cancelRead).toHaveBeenCalledWith(read.mock.calls[0][1]);
  });
  it("cancels pending extraction when the reader unmounts", async () => {
    read.mockImplementationOnce(() => new Promise(() => undefined));
    await render(); await act(async () => root.render(null));
    expect(cancelRead).toHaveBeenCalledTimes(1);
  });
  it("keeps a replacement alive through StrictMode cleanup and a late old result", async () => {
    let first!: (value: unknown) => void, second!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; })).mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }));
    await render(card, true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancelRead).toHaveBeenCalledExactlyOnceWith(read.mock.calls[0][1]);
    expect(read.mock.calls[1][1]).not.toBe(read.mock.calls[0][1]);
    await act(async () => first({ kind: "article", article: { ...article, title: "stale" } }));
    expect(update).not.toHaveBeenCalled();
    await act(async () => second({ kind: "article", article }));
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    expect(cancelRead).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending language read on entry change and ignores a late failure", async () => {
    read.mockResolvedValue({ kind: "article", article: { ...article, languageVariants: [
      { language: "en", label: "English", url: card.url }, { language: "zh", label: "中文", url: "https://example.com/zh" }
    ] } });
    let fail!: (reason: Error) => void;
    const language = vi.fn(() => new Promise<ReaderArticle>((_resolve, reject) => { fail = reject; }));
    window.reader.readEntryLanguageVariant = language;
    await render();
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(".reader-language-switcher button")).find((button) => button.textContent === "中文")!.click());
    await render({ ...card, id: "two" });
    expect(cancelRead).toHaveBeenCalledExactlyOnceWith(language.mock.calls[0][2]);
    await act(async () => fail(new Error("stale language error")));
    expect(container.textContent).not.toContain("stale language error");
  });
  it("does not surface a rejected cancellation IPC as a new reader error", async () => {
    read.mockImplementationOnce(() => new Promise(() => undefined));
    cancelRead.mockRejectedValue(new Error("cancel bridge closing"));
    await render(); await render({ ...card, id: "two" });
    expect(container.textContent).not.toContain("cancel bridge closing");
  });
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


it("switches between same-URL bodies with only the selected language pressed", async () => {
  const versions = ["zh", "en"].map(language => ({ url: card.url, language, inlineLanguage: language, label: language === "zh" ? "中文" : "English" }));
  read.mockResolvedValue({ kind: "article", article: { ...article, activeLanguage: "zh", languageVariants: versions } });
  const language = vi.fn(async (_id, _url, _request, inlineLanguage) => ({ ...article, activeLanguage: inlineLanguage, languageVariants: versions, contentHtml: "<p>Switched translation</p>" }));
  window.reader.readEntryLanguageVariant = language;
  await render();
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(".reader-language-switcher button")];
  expect(buttons().map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  await act(async () => buttons()[1].click());
  expect(language).toHaveBeenCalledWith(card.id, card.url, expect.any(String), "en");
  expect(buttons().map(button => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  expect(container.textContent).toContain("Switched translation");
  await act(async () => buttons()[0].click());
  expect(language).toHaveBeenLastCalledWith(card.id, card.url, expect.any(String), "zh");
});

it("shows a sole English alternative while hiding all other languages", async () => {
  read.mockResolvedValue({ kind: "article", article: { ...article, activeLanguage: "fr", languageVariants: [
    { url: card.url, language: "fr", label: "Français" },
    { url: "https://example.com/en", language: "en", label: "English" },
    { url: "https://example.com/ja", language: "ja", label: "日本語" }
  ] } });
  const language = vi.fn(async () => ({ ...article, url: "https://example.com/en", activeLanguage: "en" }));
  window.reader.readEntryLanguageVariant = language;
  await render();
  const buttons = container.querySelectorAll<HTMLButtonElement>(".reader-language-switcher button");
  expect(buttons).toHaveLength(1); expect(buttons[0].textContent).toBe("English");
  await act(async () => buttons[0].click());
  expect(language).toHaveBeenCalledWith(card.id, "https://example.com/en", expect.any(String), undefined);
});
