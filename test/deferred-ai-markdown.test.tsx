// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const gate = vi.hoisted(() => {
  let resolve!: () => void;
  return { ready: new Promise<void>((complete) => { resolve = complete; }), release: () => resolve(), loads: 0 };
});
// Exercise the native URL importer with a delayed, deterministic module.
vi.mock("../src/renderer/ai-markdown.tsx?chunk-url", () => ({ default: "data:text/javascript," + encodeURIComponent(`
  globalThis.__readingHubMarkdownGate.loads++;
  await globalThis.__readingHubMarkdownGate.ready;
  export const AiMarkdownContent = ({ text }) => text;
`) }));
import { DeferredAiMarkdownContent } from "../src/renderer/deferred-ai-markdown";
import { aiMarkdownResource } from "../src/renderer/ai-markdown-resource";

it("shares a deferred module without retaining stale text or reviving a closed message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__readingHubMarkdownGate", gate);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    expect(aiMarkdownResource.getSnapshot().status).toBe("idle");
    expect(gate.loads).toBe(0);
    await act(async () => root.render(<>
      <DeferredAiMarkdownContent key="first" text="Old text" />
      <DeferredAiMarkdownContent key="second" text="Closed message" />
    </>));
    expect(aiMarkdownResource.getSnapshot().status).toBe("loading");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("Old text");
    await act(async () => root.render(<DeferredAiMarkdownContent key="first" text="Latest streaming text" />));
    await act(async () => {
      gate.release();
      await vi.waitFor(() => expect(aiMarkdownResource.getSnapshot().status).toBe("ready"));
    });
    expect(gate.loads).toBe(1);
    expect(container.textContent).toBe("Latest streaming text");
    await act(async () => root.render(null));
    await act(async () => root.render(<DeferredAiMarkdownContent text="New message" />));
    expect(container.textContent).toBe("New message");
    expect(gate.loads).toBe(1);
  } finally {
    gate.release(); await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
