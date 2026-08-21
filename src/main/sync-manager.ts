import type { RawEntry, Source, SyncResult } from "../shared/types";
import { ReadingDatabase } from "./database";
import { ConnectorRegistry } from "./connector-registry";

const BACKGROUND_SYNC_CONCURRENCY = 2;

class HostGate {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(url: string, task: () => Promise<T>): Promise<T> {
    const host = new URL(url).hostname;
    const previous = this.tails.get(host) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(host, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(host) === tail) this.tails.delete(host);
    }
  }
}

export class SyncManager {
  private readonly gate = new HostGate();
  private timer?: NodeJS.Timeout;
  private dueRun?: Promise<void>;

  constructor(
    private readonly db: ReadingDatabase,
    private readonly registry: ConnectorRegistry,
    private readonly afterSuccessfulSync?: (source: Source, result: SyncResult) => Promise<void>
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scheduleDueRun(), 60_000);
    this.scheduleDueRun();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDue(): Promise<void> {
    const sources = this.db.listDueSources();
    await forEachWithConcurrency(sources, BACKGROUND_SYNC_CONCURRENCY, async (source) => {
      // A source-level error has already been recorded by syncSource, including
      // its backoff deadline. It must not turn an unattended timer tick into an
      // unhandled rejection; manual refreshes still receive the same failure.
      await this.syncSource(source.id).catch(() => undefined);
    });
  }

  async syncSource(sourceId: string): Promise<{ inserted: number; source: Source }> {
    const source = this.db.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    return this.gate.run(source.url, async () => {
      try {
        // Clean known taxonomy URLs from legacy rules even when the server replies
        // 304 and there is no new body to parse.
        const connectorId = source.connectorId ?? source.kind;
        if (connectorId === "generic") {
          this.db.deleteTaxonomyEntries(source.id);
          this.db.repairGenericHomepageEntryUrls(source);
        }
        if (connectorId === "rss") this.db.repairScourRedirectEntries(source.id);
        const subscription = this.db.getSubscriptionForSource(source.id);
        if (!subscription) throw new Error("来源订阅状态缺失，请删除后重新添加该来源。");
        const account = subscription.accountId ? this.db.getAccount(subscription.accountId) : undefined;
        const connector = this.registry.get(subscription.connectorId);
        if (connector.manifest.requiresAccount && !account) throw new Error(`${connector.manifest.displayName} 需要重新授权。`);
        const outcome = await connector.sync({ source, subscription, account, checkpoint: this.db.getCheckpoint(subscription.id) });
        let effectiveSource = connectorId === "generic" && outcome.extractionRule
          ? this.db.replaceAutomaticRule(source.id, outcome.extractionRule)
          : source;
        if (outcome.metadataRevision !== undefined) {
          effectiveSource = this.db.updateMetadataRevision(effectiveSource.id, outcome.metadataRevision);
        }
        if (outcome.iconUrl) effectiveSource = this.db.updateSourceIcon(effectiveSource.id, outcome.iconUrl);
        // Filter a narrow class of legacy RSS navigation cards only after a
        // successful response. We never delete ordinary entries merely
        // because a paginated Feed no longer returns them.
        if (!outcome.notModified) this.db.deleteNonContentFeedNavigationEntries(effectiveSource, Boolean(effectiveSource.extractionRule?.feedUrl));
        const inserted = outcome.notModified ? 0 : this.saveRawEntries(effectiveSource, outcome.entries);
        if (connectorId === "rss") this.db.repairScourRedirectEntries(effectiveSource.id);
        if (outcome.checkpoint) this.db.saveCheckpoint(subscription.id, outcome.checkpoint);
        const updated = this.db.markSuccess(effectiveSource, {
          etag: outcome.etag,
          lastModified: outcome.lastModified,
          empty: connectorId === "generic" && !outcome.emptyIsHealthy && !outcome.notModified && outcome.entries.length === 0
        });
        this.db.recordSyncEvent(source.id, updated.status === "needs_review" ? "warning" : "success", outcome.entries.length, inserted,
          updated.status === "needs_review" ? "来源需要复核提取规则" : undefined);
        await this.afterSuccessfulSync?.(updated, outcome);
        return { inserted, source: updated };
      } catch (error) {
        const updated = this.db.markFailure(source, userSafeError(error));
        throw new SyncFailure(updated.lastError || "同步失败");
      }
    });
  }

  savePreview(source: Source, entries: RawEntry[]): number {
    return this.saveRawEntries(source, entries);
  }

  private saveRawEntries(source: Source, entries: RawEntry[]): number {
    const connector = this.registry.get(source.connectorId ?? source.kind);
    const normalized = entries.map((entry) => connector.normalize(entry, source));
    return this.db.saveEntries(normalized);
  }

  private scheduleDueRun(): void {
    if (this.dueRun) return;
    this.dueRun = this.runDue()
      .catch((error) => {
        // Only infrastructure errors that prevent a whole scheduling pass from
        // running arrive here. Per-source failures are persisted above.
        console.warn("Reading Hub 后台同步未能启动：", userSafeError(error));
      })
      .finally(() => {
        this.dueRun = undefined;
      });
  }
}

export class SyncFailure extends Error {}

async function forEachWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await task(item);
    }
  }));
}

function userSafeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return "发生未知同步错误。";
}
