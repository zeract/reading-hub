// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ loads: 0, fail: true }));
vi.mock("../src/renderer/ai-markdown.tsx?chunk-url", () => ({ default: "data:text/javascript," + encodeURIComponent(`
  const gate = globalThis.__readingHubMarkdownFailure;
  gate.loads++;
  if (gate.fail) throw new Error('Synthetic bundled module failure');
  export const AiMarkdownContent = ({ text }) => text;
  // Retry URL parameters remain inside this comment.
`.trimEnd()) }));
import { DeferredAiMarkdownContent } from "../src/renderer/deferred-ai-markdown";
import { aiMarkdownResource } from "../src/renderer/ai-markdown-resource";

it("retains safe streaming text with one recovery control and restores all subscribers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__readingHubMarkdownFailure", gate);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = (answer: string) => root.render(<>
    <DeferredAiMarkdownContent key="question" text="Original question" showRecovery={false} />
    <DeferredAiMarkdownContent key="answer" text={answer} />
  </>);
  try {
    await act(async () => render("Partial answer"));
    await act(async () => { await vi.waitFor(() => expect(aiMarkdownResource.getSnapshot().status).toBe("error")); });
    expect(gate.loads).toBe(1);
    expect(container.textContent).toContain("Original question");
    expect(container.textContent).toContain("Partial answer");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("button")?.className).toBe("action-button");
    await act(async () => render('Updated answer <img src="evil">'));
    expect(container.textContent).toContain('Updated answer <img src="evil">');
    expect(container.querySelector("img")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      container.querySelector<HTMLButtonElement>("button")?.click();
      await vi.waitFor(() => expect(aiMarkdownResource.getSnapshot().status).toBe("error"));
    });
    expect(gate.loads).toBe(2);
    expect(container.textContent).toContain("Updated answer");
    gate.fail = false;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      await vi.waitFor(() => expect(aiMarkdownResource.getSnapshot().status).toBe("ready"));
    });
    expect(gate.loads).toBe(3);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe('Original questionUpdated answer <img src="evil">');
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
