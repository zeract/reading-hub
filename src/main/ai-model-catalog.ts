import type { AiModelCatalog, AiModelOption, AiProviderId } from "../shared/types";
import { validAiEffort, validAiModelId } from "../shared/ai-model";
import { awaitWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";

const TTL = 5 * 60_000;
const RETRY_DELAY = 30_000;
const INVALID = "模型列表格式无效，请刷新后重试。";
export class AiModelCatalogError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function parseModelPage(value: unknown, codex = false): { models: AiModelOption[]; cursor?: string } {
  if (!record(value) || !Array.isArray(value.data) || value.data.length > 1_000) throw new Error(INVALID);
  const models: AiModelOption[] = [];
  for (const item of value.data) {
    if (!record(item)) throw new Error(INVALID);
    const id = codex ? item.model : item.id;
    if (!validAiModelId(id)) throw new Error(INVALID);
    if (codex && item.hidden === true) continue;
    const name = typeof item.displayName === "string" ? item.displayName.trim().slice(0, 200) : id;
    const model: AiModelOption = { id, label: name || id };
    if (codex) {
      if (!Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length > 32) throw new Error(INVALID);
      model.efforts = [...new Set(item.supportedReasoningEfforts.map(option => {
        if (!record(option) || !validAiEffort(option.reasoningEffort)) throw new Error(INVALID);
        return option.reasoningEffort;
      }))];
      if (!validAiEffort(item.defaultReasoningEffort)) throw new Error(INVALID);
      model.defaultEffort = item.defaultReasoningEffort;
      model.isDefault = item.isDefault === true;
    }
    models.push(model);
  }
  const cursor = value.nextCursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !cursor.length || cursor.length > 1_000)) throw new Error(INVALID);
  return { models, cursor: typeof cursor === "string" ? cursor : undefined };
}

/** Session-local, credential-free cache. Failed refreshes never erase usable models. */
export class AiModelCatalogCache {
  private readonly cache = new Map<AiProviderId, AiModelCatalog>();
  private readonly generations = new Map<AiProviderId, number>();
  private readonly retryAt = new Map<AiProviderId, number>();
  private readonly pending = new Map<AiProviderId, Promise<AiModelCatalog>>();
  private readonly shutdown = new AbortController();

  async list(provider: AiProviderId, refresh: boolean, load: (signal: AbortSignal) => Promise<AiModelOption[]>): Promise<AiModelCatalog> {
    throwIfAborted(this.shutdown.signal);
    const generation = this.generations.get(provider) ?? 0;
    const current = () => generation === (this.generations.get(provider) ?? 0);
    const previous = this.cache.get(provider);
    if (!refresh && previous) return structuredClone({ ...previous, stale: !previous.updatedAt || Date.now() - previous.updatedAt >= TTL || Boolean(previous.error) });
    if (this.pending.has(provider)) return structuredClone(await this.pending.get(provider)!);
    if (previous && Date.now() < (this.retryAt.get(provider) ?? 0)) return structuredClone(previous);
    const request = withRequestTimeout(this.shutdown.signal, 15_000, "获取模型列表超时，请稍后刷新。");
    const task = (async () => {
      try {
        await Promise.resolve();
        throwIfAborted(request.signal);
        const models = await awaitWithAbort(load(request.signal), request.signal);
        if (!models.length || models.length > 1_000) throw new Error(INVALID);
        const result = { models: [...new Map(models.map(model => [model.id, model])).values()], updatedAt: Date.now(), stale: false };
        if (!current()) return { models: [], stale: true, error: "配置已变更，请刷新模型列表。" };
        this.cache.set(provider, result);
        this.retryAt.delete(provider);
        return result;
      } catch (error) {
        if (!current()) return { models: [], stale: true, error: "配置已变更，请刷新模型列表。" };
        // Do not expose arbitrary transport errors, provider bodies or stderr.
        const result = { models: previous?.models ?? [], updatedAt: previous?.updatedAt, stale: true,
          error: error instanceof AiModelCatalogError ? error.message
            : request.signal.aborted && !this.shutdown.signal.aborted ? "获取模型列表超时，已有选择保持不变，请稍后刷新。"
            : provider === "codex-cli" ? "无法更新模型列表，请确认本机 Codex 版本及登录状态。已有选择保持不变。"
            : "无法更新模型列表，请检查网络及已保存的 API Key。已有选择保持不变。" };
        if (!this.shutdown.signal.aborted && current()) {
          this.cache.set(provider, result);
          this.retryAt.set(provider, Date.now() + RETRY_DELAY);
        }
        return result;
      } finally { request.dispose(); if (current()) this.pending.delete(provider); }
    })();
    this.pending.set(provider, task);
    return structuredClone(await task);
  }

  invalidate(provider: AiProviderId): void {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.cache.delete(provider); this.retryAt.delete(provider); this.pending.delete(provider);
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled(this.pending.values());
    this.cache.clear();
  }
}
