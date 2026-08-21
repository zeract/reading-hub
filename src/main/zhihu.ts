import { compactText } from "../shared/text";
import { chromiumFetch } from "./network";
import type { ConnectorAdapter, Followee, RawEntry, Source, SyncContext, SyncResult } from "../shared/types";
import { builtInManifest } from "./connector-registry";
import { contentNormalizer } from "./content-normalizer";

const API_ORIGIN = "https://developer.zhihu.com";

type ApiResponse<T> = { Code?: number; Message?: string; Data?: T };
type Paged<T> = { Items?: T[]; Paging?: { IsEnd?: boolean; NextOffset?: string } };

/** Official, current-user-only API client. It intentionally has no user-id parameter. */
export class ZhihuConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("zhihu", "知乎（官方数据）", ["oauth"], ["developer.zhihu.com"]);

  constructor(private readonly getAccessSecret: () => Promise<string | null>) {}

  async sync(_context: SyncContext): Promise<SyncResult> {
    return { entries: await this.fetchEntries(), emptyIsHealthy: true };
  }

  normalize(item: RawEntry, source: Source) {
    return contentNormalizer.normalize(item, source, { providerId: "zhihu", providerLabel: "知乎" });
  }

  async fetchEntries(): Promise<RawEntry[]> {
    const contents = await this.get<Paged<any>>("/api/v1/user/contents?ContentType=all&Limit=50");
    return this.toEntries(contents.Items ?? []);
  }

  async fetchRecentCollections(): Promise<RawEntry[]> {
    const collections = await this.get<{ Items?: any[] }>("/api/v1/user/collections?Limit=50");
    return this.toEntries(collections.Items ?? []);
  }

  private toEntries(items: any[]): RawEntry[] {
    const entries: RawEntry[] = [];
    for (const item of items) {
      if (!item.Url) continue;
      entries.push({
        url: item.Url,
        title: compactText(item.Title, 240) || "知乎内容",
        publishedAt: typeof item.CreatedAt === "number" ? item.CreatedAt * 1000 : undefined,
        summary: compactText(item.Summary, 500),
        author: compactText(item.Author?.Name, 120)
      });
    }
    return entries;
  }

  async fetchFollowees(max = 200): Promise<Followee[]> {
    const output: Followee[] = [];
    let offset = "0";
    while (output.length < max) {
      const page = await this.get<Paged<any>>(`/api/v1/user/followees?Offset=${encodeURIComponent(offset)}&Limit=50`);
      output.push(
        ...(page.Items ?? []).map((item) => ({
          urlToken: String(item.UrlToken),
          fullname: compactText(item.Fullname, 120) || "知乎用户",
          url: item.Url,
          avatarUrl: item.AvatarUrl,
          headline: compactText(item.Headline, 240),
          followerCount: item.FollowerCount,
          updatedAt: Date.now()
        }))
      );
      if (page.Paging?.IsEnd || !page.Paging?.NextOffset) break;
      offset = page.Paging.NextOffset;
    }
    return output.slice(0, max);
  }

  private async get<T>(path: string): Promise<T> {
    const secret = await this.getAccessSecret();
    if (!secret) throw new Error("请先在设置中保存知乎 Access Secret。");
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await chromiumFetch(`${API_ORIGIN}${path}`, {
          headers: {
            Authorization: `Bearer ${secret}`,
            "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(25_000)
        });
        const body = (await response.json().catch(() => ({}))) as ApiResponse<T>;
        if (response.ok && body.Code === 0 && body.Data) return body.Data;
        if (response.status < 500 && body.Code !== 90001) throw new Error(body.Message || `知乎接口请求失败（HTTP ${response.status}）`);
        lastError = new Error(body.Message || `知乎服务暂时不可用（HTTP ${response.status}）`);
      } catch (error) {
        lastError = error;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (lastError instanceof Error && /timeout|timed out|aborted/i.test(lastError.message)) {
      throw new Error("知乎官方接口响应超时，请稍后重试；已保存的 Access Secret 不会丢失。");
    }
    throw lastError instanceof Error ? lastError : new Error("知乎接口请求失败。");
  }
}
