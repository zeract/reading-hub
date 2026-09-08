// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAiProviders } from "../src/renderer/use-ai-providers";
import type { AiProviderSettings } from "../src/shared/types";
const providers: AiProviderSettings[] = [{ id: "openai", label: "Fixture", configured: true, requiresApiKey: true, model: "fixture" }];
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let root: Root; let container: HTMLDivElement; let list: ReturnType<typeof vi.fn>; let state: ReturnType<typeof useAiProviders>;
function Harness({ autoLoad = true }: { autoLoad?: boolean }) { state = useAiProviders({ autoLoad }); return null; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list = vi.fn().mockResolvedValue(providers);
  Object.defineProperty(window, "reader", { configurable: true, value: { listAiProviders: list } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("loads once per view and allows a caller to own initial discovery", async () => {
  await act(async () => root.render(<Harness autoLoad={false} />));
  expect(list).not.toHaveBeenCalled(); expect(state.status).toBe("loading");
  await act(async () => { expect(await state.reload()).toBe(providers); });
  expect(state.status).toBe("ready"); expect(state.providers).toBe(providers);
  await act(async () => root.render(<Harness autoLoad={false} />));
  expect(list).toHaveBeenCalledTimes(1);
});
it("admits only one pending retry and preserves the previous snapshot without treating it as current", async () => {
  await act(async () => root.render(<Harness />));
  const retry = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(retry.promise);
  let first!: Promise<AiProviderSettings[] | undefined>;
  await act(async () => { first = state.reload(); expect(await state.reload()).toBeUndefined(); });
  expect(list).toHaveBeenCalledTimes(2); expect(state.status).toBe("loading"); expect(state.providers).toBe(providers);
  await act(async () => { retry.reject(new Error("Synthetic failure")); await first; });
  expect(state.status).toBe("error"); expect(state.error).toBe("Synthetic failure");
  await act(async () => { await state.reload(); });
  expect(state.status).toBe("ready"); expect(state.error).toBeUndefined();
});
it("makes an empty list recoverable", async () => {
  list.mockResolvedValueOnce([]);
  await act(async () => root.render(<Harness />));
  expect(state.status).toBe("error"); expect(state.error).toContain("没有可用的 AI 服务");
  await act(async () => { await state.reload(); });
  expect(state.status).toBe("ready");
});
it("captures synchronous IPC failure", async () => {
  list.mockImplementationOnce(() => { throw new Error("Synthetic IPC failure"); });
  await act(async () => root.render(<Harness />));
  expect(state.status).toBe("error"); expect(state.error).toBe("Synthetic IPC failure");
});
it("ignores stale results after StrictMode restarts discovery", async () => {
  const older = deferred<AiProviderSettings[]>(); const latest = deferred<AiProviderSettings[]>();
  list.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  await act(async () => latest.resolve(providers));
  await act(async () => older.reject(new Error("Obsolete failure")));
  expect(state.status).toBe("ready"); expect(state.error).toBeUndefined(); expect(state.providers).toBe(providers);
});
it("does not publish a late result or call IPC again after unmount", async () => {
  await act(async () => root.render(<Harness />));
  const retry = deferred<AiProviderSettings[]>(); list.mockReturnValueOnce(retry.promise);
  let result!: Promise<AiProviderSettings[] | undefined>; const reload = state.reload;
  await act(async () => { result = reload(); });
  await act(async () => root.render(null));
  await act(async () => retry.resolve(providers));
  expect(await result).toBeUndefined(); expect(await reload()).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(2);
});
