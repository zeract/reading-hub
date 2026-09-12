import type { ComponentType } from "react";
import moduleUrl from "./ai-markdown.tsx?chunk-url";

type MarkdownState = { status: "idle" | "loading" | "error" }
  | { status: "ready"; Renderer: ComponentType<{ text: string; entryId?: string }> };
let snapshot: MarkdownState = { status: "idle" };
const listeners = new Set<() => void>();
let attempt = 0;

function publish(next: MarkdownState): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** One optional bundled module shared by both AI surfaces and all messages.
 * No answer text lives here. A retry from any message restores all subscribers. */
export const aiMarkdownResource = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  load(): void {
    if (snapshot.status === "loading" || snapshot.status === "ready") return;
    publish({ status: "loading" });
    // Chromium retains failed imports by URL. Retry only this known bundled
    // module, keeping the current messages and provider requests untouched.
    const url = new URL(moduleUrl, import.meta.url);
    attempt++;
    if (attempt > 1) url.searchParams.set("reader-retry", String(attempt));
    void (import(/* @vite-ignore */ url.href) as Promise<typeof import("./ai-markdown")>).then(
      ({ AiMarkdownContent }) => publish({ status: "ready", Renderer: AiMarkdownContent }),
      () => publish({ status: "error" })
    );
  }
};
