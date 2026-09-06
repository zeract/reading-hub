import { throwIfAborted } from "./cancellation";
import type { RawEntry, Source, Subscription } from "../shared/types";
import { entryMatchesSubscriptionScope, normaliseSubscriptionScope } from "../shared/subscription-scope";
import { redactDiagnosticMessage } from "./diagnostic-redaction";
import { ContentMaintenance } from "./content-maintenance";
import { ReadingDatabase } from "./database";
import { ConnectorRegistry } from "./connector-registry";
import { KeyedTaskQueue } from "./keyed-task-queue";

const BACKGROUND_SYNC_CONCURRENCY = 2;
type SourceSyncResult = { inserted: number; source: Source };

export class SyncManager {
  private readonly gate = new KeyedTaskQueue();
  private timer?: NodeJS.Timeout;
  private dueRun?: Promise<void>;
  private readonly inFlight = new Map<string, Promise<SourceSyncResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly db: ReadingDatabase,
    private readonly registry: ConnectorRegistry,
    private readonly maintenance?: ContentMaintenance
  ) {}

  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => this.scheduleDueRun(), 60_000);
    this.scheduleDueRun();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stop admission, skip queued requests and drain active connectors before SQLite closes. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.beginShutdown();
      this.closePromise = Promise.allSettled([...this.inFlight.values(), this.dueRun]).then(() => undefined);
    }
    return this.closePromise;
  }

  beginShutdown(): void {
    this.closing = true;
    this.stop();
    for (const id of this.controllers.keys()) this.cancelSource(id);
  }

  cancelSource(sourceId: string): void {
    this.controllers.get(sourceId)?.abort(new SyncCancelledError("已取消此次同步。"));
  }

  async runDue(): Promise<void> {
    if (this.closing) return;
    const sources = this.db.listDueSources();
    await forEachWithConcurrency(sources, BACKGROUND_SYNC_CONCURRENCY, async (source) => {
      // A source-level error has already been recorded by syncSource, including
      // its backoff deadline. It must not turn an unattended timer tick into an
      // unhandled rejection; manual refreshes still receive the same failure.
      if (this.closing) return;
      const current = this.db.getSource(source.id);
      // The snapshot may have waited behind other sources while a manual
      // refresh or settings change already advanced this source's deadline.
      if (!current?.pollingEnabled || !["active", "error"].includes(current.status)
        || current.nextCheckAt === undefined || current.nextCheckAt > Date.now()) return;
      await this.syncSource(source.id).catch(() => undefined);
    });
  }

  async syncSource(sourceId: string): Promise<SourceSyncResult> {
    this.assertOpen();
    const existing = this.inFlight.get(sourceId);
    if (existing) {
      if (!this.controllers.get(sourceId)?.signal.aborted) return existing;
      // A new subscription request must not inherit a cancelled predecessor.
      await existing.catch(() => undefined);
      return this.syncSource(sourceId);
    }
    const controller = new AbortController();
    this.controllers.set(sourceId, controller);
    const pending = this.syncOnce(sourceId, controller.signal);
    this.inFlight.set(sourceId, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(sourceId);
      this.controllers.delete(sourceId);
      this.db.publishChanges();
    }
  }

  private async syncOnce(sourceId: string, signal: AbortSignal): Promise<SourceSyncResult> {
    const queuedSource = this.db.getSource(sourceId);
    if (!queuedSource) throw new Error("来源不存在。");
    return this.gate.run(new URL(queuedSource.url).hostname, async () => {
      this.assertOpen();
      throwIfAborted(signal);
      const source = this.db.getSource(sourceId);
      if (!source) throw new SyncCancelledError("来源已被删除，已取消此次同步。");
      assertSourceEnabled(source);
      const subscription = this.db.getSubscriptionForSource(source.id);
      try {
        // Historical content fixes are versioned and marker-gated. They run at
        // most once per source instead of scanning all old cards on every poll.
        this.maintenance?.prepareForSync(source);
        const connectorId = source.connectorId ?? source.kind;
        if (!subscription) throw new Error("来源订阅状态缺失，请删除后重新添加该来源。");
        const account = subscription.accountId ? this.db.getAccount(subscription.accountId) : undefined;
        const connector = this.registry.get(subscription.connectorId);
        if (connector.manifest.requiresAccount && !account) throw new Error(`${connector.manifest.displayName} 需要重新授权。`);
        const outcome = await connector.sync({ source, subscription, account, checkpoint: this.db.getCheckpoint(subscription.id), signal });
        throwIfAborted(signal);
        this.assertOpen();
        return this.db.writeTransaction(() => {
          const currentSource = currentSourceForSync(this.db, source, subscription);
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
          // A connector only maps provider records into the shared shape.  The
          // host owns collection policy so category filters cannot slowly drift
          // across RSS, web, platform, or future adapters.
          const saved = outcome.notModified
            ? { inserted: 0, accepted: 0 }
            : this.saveRawEntries(effectiveSource, outcome.entries, subscription);
          const inserted = saved.inserted;
          this.maintenance?.afterSuccessfulSync(effectiveSource);
          if (outcome.followees) this.db.upsertFollowees(outcome.followees);
          if (outcome.checkpoint) this.db.saveCheckpoint(subscription.id, outcome.checkpoint);
          const updated = this.db.markSuccess(effectiveSource, {
            etag: outcome.etag,
            lastModified: outcome.lastModified,
            empty: !outcome.emptyIsHealthy && !outcome.notModified && outcome.entries.length === 0
          });
          const eventMessage = updated.status === "needs_review"
            ? "来源需要复核提取规则"
            : outcome.entries.length > 0 && saved.accepted === 0 && subscription.scope.facetSelections.length > 0
              ? "本次内容不在已选分类内；已正常推进同步状态"
              : undefined;
          this.db.recordSyncEvent(source.id, updated.status === "needs_review" ? "warning" : "success", outcome.entries.length, inserted, eventMessage);
          return { inserted, source: updated };
        });
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof SyncCancelledError) throw error;
        this.assertOpen();
        // Success and failure must obey the same stale-result boundary.
        const currentSource = currentSourceForSync(this.db, source, subscription);
        const updated = this.db.markFailure(currentSource, userSafeError(error));
        throw new SyncFailure(updated.lastError || "同步失败");
      }
    }, signal);
  }

  savePreview(source: Source, entries: RawEntry[]): number {
    this.assertOpen();
    return this.saveRawEntries(source, entries).inserted;
  }

  private saveRawEntries(source: Source, entries: RawEntry[], subscription?: Subscription): { inserted: number; accepted: number } {
    const connector = this.registry.get(source.connectorId ?? source.kind);
    const normalized = entries.map((entry) => connector.normalize(entry, source));
    const accepted = subscription
      ? normalized.filter((entry) => entryMatchesSubscriptionScope(entry, subscription.scope))
      : normalized;
    return { inserted: this.db.saveEntries(accepted), accepted: accepted.length };
  }

  private assertOpen(): void {
    if (this.closing) throw new SyncCancelledError("应用正在退出，已取消此次同步。");
  }

  private scheduleDueRun(): void {
    if (this.closing || this.dueRun) return;
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

function currentSourceForSync(database: ReadingDatabase, initial: Source, initialSubscription?: Subscription): Source {
  const current = database.getSource(initial.id);
  if (!current) throw new SyncCancelledError("来源已被删除，已取消此次同步。");
  // An explicit pause is a user/compliance decision, not an error state to be
  // overwritten by an older in-flight response.
  assertSourceEnabled(current);
  if (current.kind !== initial.kind || (current.connectorId ?? current.kind) !== (initial.connectorId ?? initial.kind)) {
    throw new SyncCancelledError("来源类型已更新，已取消旧的同步结果。");
  }
  const currentSubscription = database.getSubscriptionForSource(current.id);
  if (initialSubscription && (!currentSubscription || currentSubscription.id !== initialSubscription.id
    || currentSubscription.accountId !== initialSubscription.accountId
    || currentSubscription.targetId !== initialSubscription.targetId
    || JSON.stringify(currentSubscription.config) !== JSON.stringify(initialSubscription.config)
    || JSON.stringify(normaliseSubscriptionScope(currentSubscription.scope)) !== JSON.stringify(normaliseSubscriptionScope(initialSubscription.scope)))) {
    throw new SyncCancelledError("收集范围已更新，已取消旧的同步结果。");
  }
  // A calibration replaces the old cards and is an explicit user decision.
  // Never reinsert an in-flight extraction based on the previous rule.
  if (initial.kind === "generic" && !sameRule(current.extractionRule, initial.extractionRule)) {
    throw new SyncCancelledError("提取规则已更新，已取消旧的同步结果。");
  }
  return current;
}

function assertSourceEnabled(source: Source): void {
  if (source.subscribed === false || !source.pollingEnabled || source.status === "paused") {
    throw new SyncCancelledError("来源已暂停，已取消此次同步。");
  }
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
  if (error instanceof Error) return redactDiagnosticMessage(error.message);
  return "发生未知同步错误。";
}
