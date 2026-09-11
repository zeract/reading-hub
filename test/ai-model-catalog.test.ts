import { afterEach, expect, it, vi } from "vitest";
import { AiModelCatalogCache, parseModelPage } from "../src/main/ai-model-catalog";
import { AiService } from "../src/main/ai-service";
import { codexAppServerTurnStartParameters, codexExecArguments } from "../src/main/codex-cli";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const model = { id: "future-model", label: "Future model" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
it("deduplicates refreshes, isolates callers, preserves cache on failure and retries after backoff", async () => {
  const cache = new AiModelCatalogCache();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const pending = deferred<typeof model[]>();
  const load = vi.fn(() => pending.promise);
  const first = cache.list("codex-cli", false, load);
  const second = cache.list("codex-cli", true, load);
  pending.resolve([model]);
  const results = await Promise.all([first, second]);
  expect(load).toHaveBeenCalledTimes(1);
  results[0].models.length = 0;
  expect(results[1].models).toEqual([model]);
  now.mockReturnValue(400_000);
  expect((await cache.list("codex-cli", false, load)).stale).toBe(true);
  const broken = vi.fn().mockRejectedValue(new Error("Bearer PRIVATE"));
  const failed = await cache.list("codex-cli", true, broken);
  expect(failed.models).toEqual([model]); expect(failed.error).not.toContain("PRIVATE");
  await cache.list("codex-cli", true, broken); expect(broken).toHaveBeenCalledTimes(1);
  now.mockReturnValue(440_000);
  expect((await cache.list("codex-cli", true, async () => [model])).stale).toBe(false);
  await cache.close();
});
it("does not revive invalidated catalogs when a previous account's request finishes late", async () => {
  const cache = new AiModelCatalogCache();
  const pending = deferred<typeof model[]>();
  const old = cache.list("openai", true, () => pending.promise);
  cache.invalidate("openai");
  await cache.list("openai", true, async () => [{ id: "new-account", label: "New" }]);
  pending.resolve([model]); await old;
  expect((await cache.list("openai", false, async () => [])).models[0].id).toBe("new-account");
  await cache.close();
});
it("cancels a stuck catalog on shutdown and rejects new discovery", async () => {
  const cache = new AiModelCatalogCache();
  let signal!: AbortSignal;
  const pending = cache.list("openai", true, value => { signal = value; return new Promise(() => {}); });
  await Promise.resolve();
  await cache.close(); await pending;
  expect(signal.aborted).toBe(true);
  await expect(cache.list("openai", true, async () => [model])).rejects.toThrow();
});
it("reads future Codex models and per-model efforts without exposing hidden entries", () => {
  const item = { id: "preset", model: "future-model", displayName: "Future", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }], defaultReasoningEffort: "ultra", isDefault: true };
  expect(parseModelPage({ data: [item, { ...item, hidden: true }], nextCursor: "next" }, true)).toEqual({ models: [{ id: "future-model", label: "Future", efforts: ["ultra"], defaultEffort: "ultra", isDefault: true }], cursor: "next" });
  expect(() => parseModelPage({ data: [{ ...item, model: "bad\nmodel" }] }, true)).toThrow();
  expect(() => parseModelPage({ data: [], nextCursor: 123 }, true)).toThrow();
  expect(codexExecArguments("question", { effort: "default" })).not.toContain("--config");
  expect(codexAppServerTurnStartParameters("thread", "question", { effort: "default" })).not.toHaveProperty("effort");
});
function secretStore() {
  const values = new Map<string, string>();
  return {
    getConnectorSecret: vi.fn(async (id?: string) => values.get(id!) ?? null),
    setConnectorSecret: vi.fn(async (connector: string, account: string, value: string) => { values.set(`${connector}:${account}`, value); return `${connector}:${account}`; }),
    clearConnectorSecret: vi.fn(async (id?: string) => { values.delete(id!); })
  };
}
it.each(["openai", "deepseek"] as const)("discovers %s through its credential-isolated API and invalidates after clearing", async provider => {
  const secrets = secretStore();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "provider/new-model" }] })));
  const service = new AiService(secrets, fetch, { status: vi.fn().mockResolvedValue({ available: false }), ask: vi.fn() });
  await service.configure({ provider, apiKey: "private-key", model: "saved-model" });
  const catalog = await service.listModels(provider);
  expect(catalog.models).toEqual([{ id: "provider/new-model", label: "provider/new-model" }]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.deepseek.com/models", expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual", headers: { authorization: "Bearer private-key" } }));
  expect(JSON.stringify(catalog)).not.toContain("private-key");
  expect((await service.listProviders()).find(p => p.id === provider)?.model).toBe("saved-model");
  await service.clear(provider);
  expect((await service.listModels(provider)).models).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
  await service.close();
});
it("does not follow model-list redirects carrying API credentials to another origin", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/private-marker" } }));
  const service = new AiService(secretStore(), fetch, { status: vi.fn().mockResolvedValue({ available: false }), ask: vi.fn() });
  await service.configure({ provider: "openai", apiKey: "private-key" });
  const result = await service.listModels("openai");
  expect(result.error).toBeTruthy(); expect(JSON.stringify(result)).not.toMatch(/private-key|private-marker/);
  expect(fetch).toHaveBeenCalledTimes(1); await service.close();
});

it("times out a stalled model directory without leaving a timer behind", async () => {
  vi.useFakeTimers();
  const cache = new AiModelCatalogCache();
  const result = cache.list("openai", true, () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await result).error).toContain("超时");
  await cache.close(); expect(vi.getTimerCount()).toBe(0);
});
it.each([401, 403, 200])("rejects unauthorized or oversized model responses safely (%s)", async status => {
  const service = new AiService(secretStore(), async () => new Response("private-key".repeat(110_000), { status }), { status: vi.fn(), ask: vi.fn() });
  await service.configure({ provider: "openai", apiKey: "private-key" });
  const result = await service.listModels("openai");
  expect(result.models).toEqual([]); expect(result.error).toBeTruthy();
  expect(result.error).not.toContain("private-key");
  if (status !== 200) expect(result.error).toContain("权限");
  await service.close();
});
