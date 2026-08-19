import { randomUUID } from "node:crypto";
import type { Account, CalibrationResult, ProbeResult, RssHubSubscriptionInput, Source, SourceInput, SourceSettings, SubscriptionDraft } from "../shared/types";
import { ReadingDatabase } from "./database";
import { isXiaohongshuUrl, manualProbe, SourceProbe } from "./source-probe";
import { SyncManager } from "./sync-manager";
import { ZhihuFollowConnector } from "./zhihu-follow";
import { assertPublicUrl } from "../shared/url";

type PendingProbe = { expiresAt: number; probe: ProbeResult };

export class SourceService {
  private readonly pending = new Map<string, PendingProbe>();

  constructor(
    private readonly db: ReadingDatabase,
    private readonly probeService: SourceProbe,
    private readonly sync: SyncManager,
    private readonly zhihuFollow: ZhihuFollowConnector
  ) {}

  async preview(url: string): Promise<{ token: string; probe: ProbeResult }> {
    const detected = await this.probeService.probe(url);
    const probe = isXiaohongshuUrl(detected.url) ? manualProbe(detected.url, detected.preview, detected.title) : detected;
    const token = randomUUID();
    this.pending.set(token, { expiresAt: Date.now() + 10 * 60_000, probe });
    this.prunePending();
    return { token, probe };
  }

  async confirm(token: string): Promise<Source> {
    const pending = this.pending.get(token);
    if (!pending || pending.expiresAt < Date.now()) throw new Error("预览已过期，请重新添加来源。");
    this.pending.delete(token);
    const { probe } = pending;
    const existing = this.db.getSourceByUrl(probe.url);
    if (existing) return existing;
    const input: SourceInput = {
      url: probe.url,
      title: probe.title,
      kind: probe.kind,
      extractionRule: probe.extractionRule,
      pollingEnabled: probe.kind !== "manual",
      status: probe.kind === "generic" && probe.confidence < 0.5 ? "needs_review" : "active"
    };
    const source = this.db.createSource(input);
    this.sync.savePreview(source, probe.preview);
    return source;
  }

  connectZhihu(): Source {
    const existing = this.db.listSources().find((source) => source.kind === "zhihu");
    if (existing) return existing;
    return this.db.createSource({
      url: "https://developer.zhihu.com/api/v1/user/contents",
      title: "知乎（本人官方数据）",
      kind: "zhihu",
      pollingEnabled: true
    });
  }

  ensureXSource(account: Account): Source {
    const existing = this.db.listSources().find((source) => source.connectorId === "x" && source.accountId === account.id);
    if (existing) return existing;
    return this.db.createSource({
      url: `https://api.x.com/2/users/${encodeURIComponent(account.subjectId || account.id)}/following`,
      title: "X 关注动态（原创帖与长文链接）",
      kind: "x",
      connectorId: "x",
      accountId: account.id,
      config: { maxFollowees: 200 },
      pollingEnabled: true
    });
  }

  /**
   * RSSHub is deliberately modelled as an RSS transport, not as a privileged
   * platform connector. This preserves the host's usual robots, request and
   * retry policies and keeps third-party credentials outside Reading Hub.
   */
  async createRssHubSource(input: RssHubSubscriptionInput): Promise<Source> {
    const url = input.url.trim();
    if (!url) throw new Error("请填写 RSSHub 路由地址。");
    const route = assertPublicUrl(url);
    const routePrefix = input.platform === "x" ? "/twitter/" : "/xiaohongshu/";
    if (!route.pathname.startsWith(routePrefix)) {
      throw new Error(input.platform === "x"
        ? "X 的 RSSHub 路由应以 /twitter/ 开头。"
        : "小红书的 RSSHub 路由应以 /xiaohongshu/ 开头。");
    }

    const probe = await this.probeService.probe(route.toString());
    if (probe.kind !== "rss") throw new Error("该 RSSHub 路由没有返回可订阅的 Feed，请检查路由、实例状态和公开访问权限。");
    const existing = this.db.getSourceByUrl(probe.url);
    if (existing) return existing;

    const providedTitle = input.title?.replace(/\s+/g, " ").trim();
    if (providedTitle && providedTitle.length > 120) throw new Error("来源名称最多 120 个字符。");
    const platformTitle = input.platform === "x" ? "X / Twitter" : "小红书";
    const source = this.db.createSource({
      url: probe.url,
      title: providedTitle || `${platformTitle} · ${probe.title}`,
      category: "平台动态",
      kind: "rss",
      connectorId: "rss",
      config: { sourceProvider: "rsshub", rsshubPlatform: input.platform },
      pollingEnabled: true
    });
    this.sync.savePreview(source, probe.preview);
    return source;
  }

  createAcademicSource(draft: SubscriptionDraft): Source {
    const config = draft.config ?? {};
    const target = draft.targetId || JSON.stringify(config);
    const url = `https://academic.local/author/${encodeURIComponent(target)}`;
    const existing = this.db.getSourceByUrl(url);
    if (existing) return existing;
    return this.db.createSource({
      url,
      title: draft.title,
      kind: "academic",
      connectorId: "academic",
      config: { ...config, targetId: draft.targetId },
      pollingEnabled: true
    });
  }

  ensureZhihuFollowSource(): Source {
    const existing = this.db.listSources().find((source) => source.kind === "zhihu_follow");
    if (existing) return existing;
    return this.db.createSource({
      url: "https://www.zhihu.com/follow",
      title: "知乎关注动态（授权会话）",
      kind: "zhihu_follow",
      pollingEnabled: true
    });
  }

  async beginZhihuFollowLogin(): Promise<void> {
    await this.zhihuFollow.beginLogin();
  }

  async calibrate(sourceId: string): Promise<CalibrationResult> {
    const source = this.db.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    if (source.kind !== "generic") throw new Error("只有普通网页来源需要校准。");
    return this.probeService.calibrate(source.url);
  }

  updateSettings(sourceId: string, settings: SourceSettings): Source {
    const source = this.db.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    const title = settings.title.trim();
    if (!title) throw new Error("请填写来源名称。");
    const category = settings.category?.replace(/\s+/g, " ").trim();
    if (category && category.length > 60) throw new Error("来源分类最多 60 个字符。");
    const publicKinds = new Set<Source["kind"]>(["rss", "generic", "manual"]);
    const sourceIsPublic = publicKinds.has(source.kind);
    const sourceUsesRssHub = source.config?.sourceProvider === "rsshub";
    if (!sourceIsPublic && settings.kind !== source.kind) throw new Error("授权平台的信源类型由连接器决定，不能在此更改。");
    if (sourceUsesRssHub && settings.kind !== source.kind) throw new Error("RSSHub 路由固定使用 Feed 连接器，不能在此更改。");
    if (sourceIsPublic && !publicKinds.has(settings.kind)) throw new Error("只能将公开来源设置为 RSS、公开网页或分享链接。");
    const interval = settings.refreshIntervalMinutes;
    if (settings.pollingEnabled && interval !== undefined && ![30, 60, 120, 240, 720, 1440].includes(interval)) {
      throw new Error("刷新间隔必须是预设的安全时间。");
    }
    const pollingEnabled = settings.kind === "manual" ? false : settings.pollingEnabled;
    return this.db.updateSourceSettings(sourceId, { ...settings, title, category, pollingEnabled, refreshIntervalMinutes: pollingEnabled ? interval : undefined });
  }

  async delete(sourceId: string): Promise<void> {
    const source = this.db.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    if (source.kind === "zhihu_follow") await this.zhihuFollow.clearSession();
    this.db.deleteSource(sourceId);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [token, item] of this.pending) if (item.expiresAt < now) this.pending.delete(token);
  }
}
