// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSourceDialog } from "../src/renderer/source-dialogs";
import { stubDialogPlatform } from "./dialog-platform";

stubDialogPlatform();
const cases = [
  { label: "知乎动态", method: "connectZhihuFollow", fields: {} },
  { label: "X 动态", method: "connectX", fields: { "x-client-id": "fixture-client" } },
  { label: "小红书", method: "subscribeXiaohongshuProfile", fields: { "xiaohongshu-profile-url": "https://www.xiaohongshu.com/user/profile/fixture", "xiaohongshu-profile-title": "Fixture author" } }
] as const;
let root: Root;
let container: HTMLDivElement;
let request: ReturnType<typeof vi.fn>;
let saved: ReturnType<typeof vi.fn>;
const mount = () => root.render(<AddSourceDialog onClose={() => root.render(null)} onPreview={() => undefined} onImportOpml={vi.fn()} onZhihuStarted={saved} onXStarted={saved} onXiaohongshuSaved={saved} onAcademicSaved={saved} />);
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request = vi.fn().mockResolvedValue(undefined); saved = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "reader", { configurable: true, value: Object.fromEntries(cases.map(({ method }) => [method, request])) });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => mount());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function select(item: typeof cases[number]) {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === item.label)!.click());
  for (const [id, value] of Object.entries(item.fields)) await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() {
  const form = container.querySelector("form");
  if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  else container.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.click();
}

describe.each(cases)("$label connection lifetime", (item) => {
  it("starts only one operation before the disabled state renders", async () => {
    let resolve!: () => void;
    request.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    await select(item); await act(async () => { submit(); submit(); });
    expect(request).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("正在");
    await act(async () => resolve());
    expect(saved).toHaveBeenCalledOnce();
  });

  it("retains the draft on failure and permits retry", async () => {
    request.mockRejectedValueOnce(new Error("Synthetic connection failure"));
    await select(item); await act(async () => submit());
    expect(container.querySelector(".error")?.textContent).toBe("Synthetic connection failure");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Synthetic connection failure");
    expect(container.querySelector('[role="alert"]')?.getAttribute("tabindex")).toBe("0");
    expect(container.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.disabled).toBe(false);
    for (const [id, value] of Object.entries(item.fields)) expect(container.querySelector<HTMLInputElement>(`#${id}`)!.value).toBe(value);
    await act(async () => submit());
    expect(saved).toHaveBeenCalledOnce(); expect(container.querySelector(".error")).toBeNull();
  });

  it("does not show a closed operation's failure in a replacement pane", async () => {
    let reject!: (reason: Error) => void;
    request.mockReturnValue(new Promise<void>((_done, fail) => { reject = fail; }));
    await select(item); await act(async () => submit());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    await act(async () => mount()); await select(item);
    await act(async () => reject(new Error("Obsolete failure")));
    expect(container.querySelector(".error")).toBeNull(); expect(saved).not.toHaveBeenCalled();
  });

  it("finishes an authorized operation once even when its pane closes", async () => {
    let resolve!: () => void;
    request.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    await select(item); await act(async () => submit());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    await act(async () => resolve());
    expect(saved).toHaveBeenCalledOnce(); expect(container.querySelector("dialog")).toBeNull();
  });
});
