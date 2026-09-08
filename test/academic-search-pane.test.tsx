// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSourceDialog } from "../src/renderer/source-dialogs";
import type { SubscriptionDraft } from "../src/shared/types";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();

let root: Root;
let container: HTMLDivElement;
let search: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let saved: ReturnType<typeof vi.fn>;
const author: SubscriptionDraft = { title: "First Author · OpenAlex A1", targetId: "openalex:A1" };
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  search = vi.fn(async () => [author]);
  subscribe = vi.fn().mockResolvedValue(undefined);
  saved = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "reader", { configurable: true, value: { searchAcademicAuthors: search, subscribeAcademicAuthor: subscribe } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<AddSourceDialog onClose={() => undefined} onPreview={() => undefined} onImportOpml={vi.fn()} onZhihuStarted={async () => undefined} onXStarted={async () => undefined} onXiaohongshuSaved={async () => undefined} onAcademicSaved={saved} />));
  const tab = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) => button.textContent === "学术作者")!;
  await act(async () => tab.click());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function typeQuery(value: string) {
  const input = container.querySelector<HTMLInputElement>("#academic-query")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("academic search results", () => {
  it("removes selectable results as soon as the search name changes", async () => {
    await typeQuery("First"); await submit();
    expect(container.querySelector(".academic-results")?.textContent).toContain("First Author");
    await typeQuery("Second");
    expect(container.querySelector(".academic-results")).toBeNull();
    search.mockRejectedValueOnce(new Error("search unavailable"));
    await submit();
    expect(container.querySelector(".error")?.textContent).toBe("search unavailable");
    expect(container.querySelector(".academic-results")).toBeNull();
  });

  it("ignores the response for a name edited while its request was in flight", async () => {
    let resolve!: (value: SubscriptionDraft[]) => void;
    search.mockImplementationOnce(() => new Promise<SubscriptionDraft[]>((done) => { resolve = done; }));
    await typeQuery("First"); await submit();
    await typeQuery("Second");
    await act(async () => resolve([author]));
    expect(container.querySelector(".academic-results")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("#academic-query")?.value).toBe("Second");
    search.mockResolvedValueOnce([{ ...author, title: "Second Author" }]);
    await submit();
    expect(container.querySelector(".academic-results")?.textContent).toContain("Second Author");
  });

  it("starts a replacement search without waiting for the old request", async () => {
    let resolveOld!: (value: SubscriptionDraft[]) => void;
    let resolveCurrent!: (value: SubscriptionDraft[]) => void;
    search.mockImplementationOnce(() => new Promise<SubscriptionDraft[]>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<SubscriptionDraft[]>((resolve) => { resolveCurrent = resolve; }));
    await typeQuery("First"); await submit();
    await typeQuery("Second"); await submit();
    expect(search).toHaveBeenCalledTimes(2);
    await act(async () => resolveOld([author]));
    expect(container.querySelector<HTMLButtonElement>(".connector-search button")!.disabled).toBe(true);
    expect(container.querySelector(".academic-results")).toBeNull();
    await act(async () => resolveCurrent([{ ...author, title: "Second Author" }]));
    expect(container.querySelector(".academic-results")?.textContent).toContain("Second Author");
  });

  it("does not surface an obsolete failure after the replacement succeeds", async () => {
    let reject!: (reason: Error) => void;
    search.mockImplementationOnce(() => new Promise<SubscriptionDraft[]>((_resolve, fail) => { reject = fail; }));
    await typeQuery("First"); await submit();
    await typeQuery("Second"); await submit();
    await act(async () => reject(new Error("Obsolete failure")));
    expect(container.querySelector(".error")).toBeNull();
    expect(container.querySelector(".academic-results")).not.toBeNull();
  });

  it("starts only one search before React commits the busy state", async () => {
    let resolve!: (value: SubscriptionDraft[]) => void;
    search.mockImplementation(() => new Promise<SubscriptionDraft[]>((done) => { resolve = done; }));
    await typeQuery("First");
    await act(async () => {
      const form = container.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(search).toHaveBeenCalledOnce();
    await act(async () => resolve([author]));
  });

  it("keeps subscription locked when the query changes and finishes it once", async () => {
    let resolve!: () => void;
    subscribe.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    await typeQuery("First"); await submit();
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>(".academic-results button")!;
      button.click(); button.click();
    });
    await typeQuery("Second"); await submit();
    expect(subscribe).toHaveBeenCalledExactlyOnceWith(author);
    expect(search).toHaveBeenCalledOnce();
    await act(async () => resolve());
    expect(saved).toHaveBeenCalledOnce();
  });

  it("shows subscription failure and lets the same author be retried", async () => {
    subscribe.mockRejectedValueOnce(new Error("Subscription failed"));
    await typeQuery("First"); await submit();
    await act(async () => container.querySelector<HTMLButtonElement>(".academic-results button")!.click());
    expect(container.querySelector(".error")?.textContent).toBe("Subscription failed");
    await act(async () => container.querySelector<HTMLButtonElement>(".academic-results button")!.click());
    expect(subscribe).toHaveBeenCalledTimes(2); expect(saved).toHaveBeenCalledOnce();
  });

  it("ignores results after switching away and returning to academic search", async () => {
    let resolve!: (value: SubscriptionDraft[]) => void;
    search.mockImplementationOnce(() => new Promise<SubscriptionDraft[]>((done) => { resolve = done; }));
    await typeQuery("First"); await submit();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    await act(async () => tabs.find((button) => button.textContent === "网页 / Feed")!.click());
    await act(async () => tabs.find((button) => button.textContent === "学术作者")!.click());
    await act(async () => resolve([author]));
    expect(container.querySelector(".academic-results")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("#academic-query")!.value).toBe("");
  });
});
