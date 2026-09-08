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
const author: SubscriptionDraft = { title: "First Author · OpenAlex A1", targetId: "openalex:A1" };
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  search = vi.fn(async () => [author]);
  Object.defineProperty(window, "reader", { configurable: true, value: { searchAcademicAuthors: search } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<AddSourceDialog onClose={() => undefined} onPreview={async () => undefined} onImportOpml={vi.fn()} onZhihuStarted={async () => undefined} onXStarted={async () => undefined} onXiaohongshuSaved={async () => undefined} onAcademicSaved={async () => undefined} />));
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
});
