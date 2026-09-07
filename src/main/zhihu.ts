import { ApiRequestBoundaryError } from "./api-response";
import { throwIfAborted, delayWithAbort, awaitWithAbort, RequestAbortedError } from "./cancellation";
import { InvalidJsonResponseError, requestJsonWithTimeout } from "./json-response";
import { readZhihuEntries, readZhihuEnvelope, readZhihuFolloweePage, ZhihuResponseError } from "./zhihu-response";
import { chromiumFetch } from "./network";
import type { ConnectorAdapter, Followee, RawEntry, Source, SyncContext, SyncResult } from "../shared/types";
import { builtInManifest } from "./connector-registry";
import { contentNormalizer } from "./content-normalizer";

const API_ORIGIN = "https://developer.zhihu.com";

class ZhihuRequestError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = "ZhihuRequestError"; }
}

/** Official, current-user-only API client. It intentionally has no user-id parameter. */
export class ZhihuConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("zhihu", "知乎（官方数据）", ["oauth"], ["developer.zhihu.com"]);

  constructor(private readonly getAccessSecret: () => Promise<string | null>) {}

  async sync(context: SyncContext): Promise<SyncResult> {
    const entries = await this.fetchEntries(context.signal);
    // Supplementary endpoints stay best-effort, but their results must pass
    // the same host-owned stale checks, scope filter and transaction as cards.
    const [collections, followees] = await Promise.allSettled([this.fetchRecentCollections(context.signal), this.fetchFollowees(200, context.signal)]);
    throwIfAborted(context.signal);
    return {
      entries: [...entries, ...(collections.status === "fulfilled" ? collections.value : [])],
      followees: followees.status === "fulfilled" ? followees.value : undefined,
      emptyIsHealthy: true
    };
  }

  normalize(item: RawEntry, source: Source) {
    return contentNormalizer.normalize(item, source, { providerId: "zhihu", providerLabel: "知乎" });
  }

  async fetchEntries(signal?: AbortSignal): Promise<RawEntry[]> {
    return readZhihuEntries(await this.get("/api/v1/user/contents?ContentType=all&Limit=50", signal));
  }

  async fetchRecentCollections(signal?: AbortSignal): Promise<RawEntry[]> {
    return readZhihuEntries(await this.get("/api/v1/user/collections?Limit=50", signal));
  }

  async fetchFollowees(max = 200, signal?: AbortSignal): Promise<Followee[]> {
    throwIfAborted(signal);
    if (!Number.isSafeInteger(max) || max < 0) throw new Error("知乎关注数量限制无效。");
    const output: Followee[] = [];
    const seenTokens = new Set<string>();
    const seenOffsets = new Set<string>();
    let offset = "0";
    while (output.length < max) {
      throwIfAborted(signal);
      if (seenOffsets.has(offset) || seenOffsets.size >= 20) throw new ZhihuRequestError("知乎关注列表分页异常，已停止读取，请稍后重试。");
      seenOffsets.add(offset);
      const page = readZhihuFolloweePage(await this.get(`/api/v1/user/followees?Offset=${encodeURIComponent(offset)}&Limit=50`, signal));
      for (const entry of page.entries) {
        if (!seenTokens.has(entry.urlToken)) { seenTokens.add(entry.urlToken); output.push(entry); }
      }
      if (!page.next) break;
      offset = page.next;
    }
    return output.slice(0, max);
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    let secret: string | null;
    try { secret = await awaitWithAbort(this.getAccessSecret(), signal); }
    catch { throwIfAborted(signal); throw new ZhihuRequestError("无法读取知乎授权配置，请在设置中检查 Access Secret。"); }
    throwIfAborted(signal);
    if (!secret) throw new Error("请先在设置中保存知乎 Access Secret。");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { response, payload: body } = await requestJsonWithTimeout<unknown>(chromiumFetch, `${API_ORIGIN}${path}`, {
          headers: {
            Authorization: `Bearer ${secret}`,
            "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
            "Content-Type": "application/json"
          }
        }, signal, 25_000);
        // Never persist an arbitrary provider error body, which can echo the
        // request's credentials. Status is enough to offer a useful action.
        if (response.status === 401 || response.status === 403) throw new ZhihuRequestError("知乎授权无效或权限不足，请在设置中检查 Access Secret。");
        if (response.status === 429) throw new ZhihuRequestError("知乎接口请求过于频繁，请稍后重试。");
        if (!response.ok) throw new ZhihuRequestError(`知乎接口请求失败（HTTP ${response.status}），请稍后重试。`, response.status >= 500);
        const envelope = readZhihuEnvelope(body);
        if (envelope.code === 0) return envelope.data;
        throw new ZhihuRequestError("知乎接口暂时无法提供数据，请稍后重试。", envelope.code === 90001);
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof InvalidJsonResponseError || error instanceof ApiRequestBoundaryError || error instanceof ZhihuResponseError) throw error;
        const failure = error instanceof ZhihuRequestError ? error : error instanceof RequestAbortedError
          ? new ZhihuRequestError("知乎官方接口响应超时，请稍后重试；已保存的 Access Secret 不会丢失。", true)
          : new ZhihuRequestError("无法连接知乎官方接口，请检查网络或代理设置后重试。", true);
        if (!failure.retryable || attempt === 1) throw failure;
      }
      if (attempt === 0) await delayWithAbort(800, signal);
    }
    throw new ZhihuRequestError("知乎接口请求失败。");
  }
}
