// @vitest-environment jsdom
import { ReaderPreferencesProvider } from "../src/renderer/reader-preferences-context";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderView } from "../src/renderer/reader-view";
import type { AiProviderSettings, AiStreamEvent, Entry } from "../src/shared/types";

const providers: AiProviderSettings[] = ["codex-cli", "openai", "deepseek"].map((id) => ({
  id: id as AiProviderSettings["id"], label: id, configured: true, requiresApiKey: id !== "codex-cli", model: "fixture"
}));
const entry: Entry = { id: "fixture", sourceId: "source", url: "https://example.com/article", canonicalUrl: "https://example.com/article", title: "Fixture", read: true, favorite: false, contentHash: "fixture", createdAt: 1 };
let root: Root;
let container: HTMLDivElement;
let list: ReturnType<typeof vi.fn>;
let start: ReturnType<typeof vi.fn>;
let receive: (event: AiStreamEvent) => void;
let pending: Array<{ resolve(value: AiProviderSettings[]): void; reject(error: Error): void }>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pending = [];
  list = vi.fn().mockResolvedValue(providers);
  start = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "reader", { configurable: true, value: {
    readEntry: vi.fn(async () => ({ kind: "article", article: { entryId: entry.id, url: entry.url, title: "Fixture", renderProfile: "standard", contentHtml: "<p>Fixture body</p>" } })),
    cancelEntryRead: vi.fn(async () => undefined), listAiProviders: list,
    onAiStream: vi.fn((listener) => { receive = listener; return () => undefined; }), startAiStream: start, cancelAiStream: vi.fn(async () => undefined)
  } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ReaderPreferencesProvider><ReaderView favoriteUpdating={false} entry={entry} onUpdateEntry={async () => true} readerOnly={false} onToggleReaderOnly={() => undefined} onOpenSettings={() => undefined} /></ReaderPreferencesProvider>));
  await click("打开 AI 学习");
  list.mockImplementation(() => new Promise<AiProviderSettings[]>((resolve, reject) => pending.push({ resolve, reject })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function click(label: string) { await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()); }
async function select(value: string) {
  await act(async () => {
    const selector = container.querySelector<HTMLSelectElement>("#ai-provider")!;
    selector.value = value; selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const selected = () => container.querySelector<HTMLSelectElement>("#ai-provider")!.value;

describe("AI provider discovery lifetime", () => {
  it("invalidates the previous discovery at selection time before React effect cleanup", async () => {
    await select("openai");
    await act(async () => {
      const selector = container.querySelector<HTMLSelectElement>("#ai-provider")!;
      selector.value = "deepseek";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
      pending[0].resolve(providers);
      await Promise.resolve();
    });
    expect(selected()).toBe("deepseek");
  });

  it("keeps the latest choice and sends the next question to it after older discovery completes", async () => {
    await select("openai"); await select("deepseek");
    expect(pending).toHaveLength(2);
    await act(async () => pending[1].resolve(providers));
    await act(async () => pending[0].resolve(providers.map((provider) => ({ ...provider, label: "Stale label" }))));
    expect(selected()).toBe("deepseek");
    expect(container.textContent).not.toContain("Stale label");
    await act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>("#ai-question")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Explain this article");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form.ai-question")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0].request.provider).toBe("deepseek");
  });

  it("does not surface a stale failure after the latest provider discovery succeeds", async () => {
    await select("openai"); await select("deepseek");
    await act(async () => pending[1].resolve(providers));
    await act(async () => pending[0].reject(new Error("Synthetic obsolete discovery failure")));
    expect(selected()).toBe("deepseek");
    expect(container.textContent).not.toContain("Synthetic obsolete discovery failure");
  });

  it("does not let a closed panel change the preferred provider for its replacement", async () => {
    await select("openai"); await select("deepseek");
    await click("关闭 AI 学习助手");
    await act(async () => pending[1].resolve(providers));
    await act(async () => pending[0].resolve(providers));
    list.mockResolvedValue(providers);
    await click("打开 AI 学习");
    expect(selected()).toBe("deepseek");
  });

  it("reports a current failure and recovers when another selection succeeds", async () => {
    await select("openai");
    await act(async () => pending[0].reject(new Error("Synthetic current discovery failure")));
    expect(container.textContent).toContain("Synthetic current discovery failure");
    await select("deepseek");
    await act(async () => pending[1].resolve(providers));
    expect(selected()).toBe("deepseek");
    expect(container.textContent).not.toContain("Synthetic current discovery failure");
  });
});

async function askQuestion(text: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>("#ai-question")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form.ai-question")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  return start.mock.calls.at(-1)![0].requestId as string;
}
const answerLabels = () => [...container.querySelectorAll(".ai-message.assistant > strong")].map((element) => element.textContent);

it("keeps each completed answer attributed to the provider that received its question", async () => {
  list.mockResolvedValue(providers);
  const first = await askQuestion("First question");
  await act(async () => receive({ requestId: first, type: "complete", answer: { provider: "codex-cli", model: "fixture", text: "First answer" } }));
  await select("openai");
  expect(answerLabels()).toEqual(["codex-cli"]);
  const second = await askQuestion("Second question");
  expect(start.mock.calls.map(([request]) => request.request.provider)).toEqual(["codex-cli", "openai"]);
  expect(answerLabels()).toEqual(["codex-cli", "openai"]);
  await act(async () => receive({ requestId: second, type: "complete", answer: { provider: "openai", model: "fixture", text: "Second answer" } }));
  await select("deepseek");
  expect(answerLabels()).toEqual(["codex-cli", "openai"]);
  await click("最小化 AI 学习助手"); await click("恢复 AI 学习助手");
  expect(answerLabels()).toEqual(["codex-cli", "openai"]);
  expect(start).toHaveBeenCalledTimes(2);
});

it("retains the original service label for interrupted and rejected requests", async () => {
  list.mockResolvedValue(providers);
  const first = await askQuestion("Interrupted question");
  await act(async () => receive({ requestId: first, type: "error", message: "Synthetic interrupted answer" }));
  await select("openai");
  start.mockRejectedValueOnce(new Error("Synthetic dispatch failure"));
  await askQuestion("Rejected question");
  await select("deepseek");
  expect(answerLabels()).toEqual(["codex-cli", "openai"]);
  expect(container.querySelectorAll(".ai-message.assistant.error")).toHaveLength(2);
});

it("does not relabel historical answers when provider metadata is refreshed", async () => {
  const first = await askQuestion("Historical question");
  await act(async () => receive({ requestId: first, type: "complete", answer: { provider: "codex-cli", model: "fixture", text: "Historical answer" } }));
  list.mockResolvedValue(providers.map((provider) => ({ ...provider, label: `Updated ${provider.id}` })));
  await select("openai"); await select("codex-cli");
  expect(answerLabels()).toEqual(["codex-cli"]);
  const second = await askQuestion("Current question");
  expect(answerLabels()).toEqual(["codex-cli", "Updated codex-cli"]);
  await act(async () => receive({ requestId: second, type: "complete", answer: { provider: "codex-cli", model: "fixture", text: "Current answer" } }));
});
