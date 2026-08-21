import type { RawEntry, Source, SyncResult } from "../shared/types";
import { ContentMaintenance } from "./content-maintenance";
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
    private readonly afterSuccessfulSync?: (source: Source, result: SyncResult) => Promise<void>,
    private readonly maintenance?: ContentMaintenance
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
    const queuedSource = this.db.getSource(sourceId);
    if (!queuedSource) throw new Error("来源不存在。");
    return this.gate.run(queuedSource.url, async () => {
      const source = this.db.getSource(sourceId);
      if (!source) throw new SyncCancelledError("来源已被删除，已取消此次同步。");
      try {
        // Historical content fixes are versioned and marker-gated. They run at
        // most once per source instead of scanning all old cards on every poll.
        this.maintenance?.prepareForSync(source);
        const connectorId = source.connectorId ?? source.kind;
        const subscription = this.db.getSubscriptionForSource(source.id);
        if (!subscription) throw new Error("来源订阅状态缺失，请删除后重新添加该来源。");
        const account = subscription.accountId ? this.db.getAccount(subscription.accountId) : undefined;
        const connector = this.registry.get(subscription.connectorId);
        if (connector.manifest.requiresAccount && !account) throw new Error(`${connector.manifest.displayName} 需要重新授权。`);
        const outcome = await connector.sync({ source, subscription, account, checkpoint: this.db.getCheckpoint(subscription.id) });
        const currentSource = currentSourceForSync(this.db, source, subscription.connectorId);
        let effectiveSource = connectorId === "generic" && outcome.extractionRule
          ? this.db.replaceAutomaticRule(currentSource.id, outcome.extractionRule)
          : currentSource;
        if (outcome.metadataRevision !== undefined) {
          effectiveSource = this.db.updateMetadataRevision(effectiveSource.id, outcome.metadataRevision);
        }
        if (outcome.iconUrl) effectiveSource = this.db.updateSourceIcon(effectiveSource.id, outcome.iconUrl);
        // Filter a narrow class of legacy RSS navigation cards only after a
        // successful response. We never delete ordinary entries merely
        // because a paginated Feed no longer returns them.
        if (!outcome.notModified) this.db.deleteNonContentFeedNavigationEntries(effectiveSource, Boolean(effectiveSource.extractionRule?.feedUrl));
        const inserted = outcome.notModified ? 0 : this.saveRawEntries(effectiveSource, outcome.entries);
        this.maintenance?.afterSuccessfulSync(effectiveSource);
        if (outcome.checkpoint) this.db.saveCheckpoint(subscription.id, outcome.checkpoint);
        const updated = this.db.markSuccess(effectiveSource, {
          etag: outcome.etag,
          lastModified: outcome.lastModified,
          empty: !outcome.emptyIsHealthy && !outcome.notModified && outcome.entries.length === 0
        });
        this.db.recordSyncEvent(source.id, updated.status === "needs_review" ? "warning" : "success", outcome.entries.length, inserted,
          updated.status === "needs_review" ? "来源需要复核提取规则" : undefined);
        await this.afterSuccessfulSync?.(updated, outcome);
        return { inserted, source: updated };
      } catch (error) {
        if (error instanceof SyncCancelledError) throw error;
        // Settings may have changed while a network request was in flight.
        // Record a real transport/parser failure against the newest state,
        // rather than reviving an older failure count or a deleted source.
        const currentSource = this.db.getSource(source.id);
        if (!currentSource) throw new SyncCancelledError("来源已被删除，已取消此次同步。");
        const updated = this.db.markFailure(currentSource, userSafeError(error));
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
export class SyncCancelledError extends Error {}

function currentSourceForSync(database: ReadingDatabase, initial: Source, connectorId: string): Source {
  const current = database.getSource(initial.id);
  if (!current) throw new SyncCancelledError("来源已被删除，已取消此次同步。");
  if (current.kind !== initial.kind || (current.connectorId ?? current.kind) !== connectorId) {
    throw new SyncCancelledError("来源类型已更新，已取消旧的同步结果。");
  }
  // A calibration replaces the old cards and is an explicit user decision.
  // Never reinsert an in-flight extraction based on the previous rule.
  if (initial.kind === "generic" && !sameRule(current.extractionRule, initial.extractionRule)) {
    throw new SyncCancelledError("提取规则已更新，已取消旧的同步结果。");
  }
  return current;
}

function sameRule(left: Source["extractionRule"], right: Source["extractionRule"]): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

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
