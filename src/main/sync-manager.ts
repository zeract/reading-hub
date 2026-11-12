import {currentSourceForSync,assertSourceEnabled,SyncCancelledError} from "./sync-state";
import type { ArticleLibrary } from "./article-library";
import { isRecruitmentUrl } from "./content-eligibility";
import { throwIfAborted } from "./cancellation";
import type { RawEntry, Source, Subscription } from "../shared/types";
import { createSubscriptionScopeMatcher } from "../shared/subscription-scope";
import { redactDiagnosticMessage } from "./diagnostic-redaction";
import { ContentMaintenance } from "./content-maintenance";
import { ReadingDatabase } from "./database";
import { ConnectorRegistry } from "./connector-registry";
import { KeyedTaskQueue } from "./keyed-task-queue";
import { RobotsRateLimitedError, RobotsUnreachableError } from "./robots";
import { NetworkRequestError } from "./http";

const BACKGROUND_SYNC_CONCURRENCY = 2;
type SourceSyncResult = { inserted: number; source: Source };

export class SyncManager {
  private readonly gate = new KeyedTaskQueue();
  private timer?: NodeJS.Timeout;
  private dueRun?: Promise<void>;
  private dueRequested = false;
  private dueWake?:()=>void;
  private readonly inFlight = new Map<string, Promise<SourceSyncResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private closing = false;
  private closePromise?: Promise<void>;
  private wasOnline = true;

  constructor(
    private readonly db: ReadingDatabase,
    private readonly registry: ConnectorRegistry,
    private readonly maintenance?: ContentMaintenance,
    private readonly connectivity?: { isOnline(): boolean; onRestored(): void },
    private readonly articles?: ArticleLibrary
  ) {}

  start(): void {
    if (this.timer || this.closing) return;
    this.wasOnline = this.connectivity?.isOnline() ?? true;
    this.timer = setInterval(() => this.tick(), 60_000);
    if (this.wasOnline) this.requestDueRun();
  }

  private tick(): void {
    if (this.closing) return;
    const online = this.connectivity?.isOnline() ?? true;
    if (online && !this.wasOnline) this.connectivity?.onRestored();
    this.wasOnline = online;
    if (online) this.requestDueRun();
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
    this.dueRequested = false;
    this.dueWake?.();
    this.stop();
    for (const id of this.controllers.keys()) this.cancelSource(id);
  }

  cancelSource(sourceId: string): void {
    this.controllers.get(sourceId)?.abort(new SyncCancelledError("已取消此次同步。"));
  }

  async runDue(): Promise<void> {
    if (this.closing) return;
    const sources = this.db.listDueSources();
    await forEachWithKeyedConcurrency(sources, BACKGROUND_SYNC_CONCURRENCY, (source) => new URL(source.url).hostname, async (source) => {
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
    },()=>this.closing?[]:this.db.listDueSources(),source=>source.id,()=>new Promise<void>(resolve=>{this.dueWake=resolve;}));
    this.dueWake=undefined;
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
        if(this.maintenance)await this.db.write("prepareSourceMaintenance",source);
        if (!subscription) throw new Error("来源订阅状态缺失，请删除后重新添加该来源。");
        const account = subscription.accountId ? this.db.getAccount(subscription.accountId) : undefined;
        const connector = this.registry.get(subscription.connectorId);
        if (connector.manifest.requiresAccount && !account) throw new Error(`${connector.manifest.displayName} 需要重新授权。`);
        const outcome = await connector.sync({ source, subscription, account, checkpoint: this.db.getCheckpoint(subscription.id), signal,
          knownArticleMetadata: entry => {
            throwIfAborted(signal);
            this.assertOpen();
            const url = connector.normalize(entry, source).canonicalUrl;
            return { publishedAt: this.db.getPublishedAtByCanonicalUrl(url), hasOriginal: this.db.articles.hasOriginalForUrl(url) };
          }
        });
        throwIfAborted(signal);
        this.assertOpen();
        const incoming = outcome.entries.map(entry => connector.normalize(entry, source))
          .filter(createSubscriptionScopeMatcher(subscription.scope));
        const bodies = await this.articles?.prepareFeedBodies(incoming, outcome.bodies, signal);
        throwIfAborted(signal);
        this.assertOpen();
        const {bodies: _rawBodies,...commitOutcome}=outcome;
        const committed = await this.db.write("commitSync", {
          source,subscription,outcome:commitOutcome,
          accepted:this.prepareEntries(source,outcome.entries,subscription),
          identityNamespaces:connector.manifest.identityNamespaces??[],bodies:bodies?[...bodies]:undefined,maintain:Boolean(this.maintenance)
        });
        this.articles?.wake();
        return committed;
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof SyncCancelledError) throw error;
        this.assertOpen();
        // Success and failure must obey the same stale-result boundary.
        currentSourceForSync(this.db, source, subscription);
        const retryAfterMs = error instanceof RobotsRateLimitedError ? 60 * 60_000
          : error instanceof RobotsUnreachableError || error instanceof NetworkRequestError ? 5 * 60_000
            : undefined;
        const updated = await this.db.write("commitSyncFailure",source,subscription,userSafeError(error),retryAfterMs);
        throw new SyncFailure(updated.lastError || "同步失败");
      }
    }, signal);
  }

  wakeArticles():void{this.articles?.wake();}
  prepareEntries(source:Source,entries:RawEntry[],subscription?:Subscription) {
    const connector=this.registry.get(source.connectorId??source.kind);
    const eligible=connector.manifest.entryPolicy==="article-links"?entries.filter(entry=>!isRecruitmentUrl(entry.url)):entries;
    const normalized=eligible.map(entry=>connector.normalize(entry,source));
    return subscription?normalized.filter(createSubscriptionScopeMatcher(subscription.scope)):normalized;
  }
  identityNamespaces(source:Source){return this.registry.get(source.connectorId??source.kind).manifest.identityNamespaces??[];}

  private assertOpen(): void {
    if (this.closing) throw new SyncCancelledError("应用正在退出，已取消此次同步。");
  }

  /** Timer ticks and committed imports share one tracked scheduler. A wake
   * during a pass requests one fresh snapshot after it drains, rather than
   * launching a competing batch or losing newly imported sources. */
  requestDueRun(): void {
    if (this.closing) return;
    this.dueRequested = true;
    if (this.dueRun) {this.dueWake?.();return;}
    this.dueRun = Promise.resolve().then(async () => {
      while (this.dueRequested && !this.closing) {
        this.dueRequested = false;
        await this.runDue();
      }
    })
      .catch((error) => {
        // Only infrastructure errors that prevent a whole scheduling pass from
        // running arrive here. Per-source failures are persisted above.
        console.warn("Reading Hub 后台同步未能启动：", userSafeError(error));
      })
      .finally(() => {
        this.dueRun = undefined;
        // Include wakes delivered during error reporting/final cleanup.
        if (this.dueRequested) this.requestDueRun();
      });
  }
}

export class SyncFailure extends Error {}
export {SyncCancelledError} from "./sync-state";

/** Admit the earliest runnable item, so a host waiting on its own predecessor
 * cannot consume another background slot. The shared gate still serializes
 * these requests with manual refreshes. On infrastructure failure, stop
 * admission and drain started work before releasing the scheduling pass. */
async function forEachWithKeyedConcurrency<T>(items: T[], limit: number, keyOf: (item: T) => string, task: (item: T) => Promise<void>,refresh:()=>T[],idOf:(item:T)=>string,waitForChange:()=>Promise<void>): Promise<void> {
  const pending = items.map((item) => ({ item, key: keyOf(item) }));
  const active = new Map<string, Promise<void>>();
  const seen=new Set(items.map(idOf));
  let failure: { error: unknown } | undefined;
  while ((!failure && pending.length) || active.size) {
    if(!failure)for(const item of refresh()){const id=idOf(item);if(!seen.has(id)){seen.add(id);pending.push({item,key:keyOf(item)});}}
    while (!failure && active.size < Math.max(limit, 1)) {
      const index = pending.findIndex(({ key }) => !active.has(key));
      if (index < 0) break;
      const { item, key } = pending.splice(index, 1)[0];
      const operation = Promise.resolve().then(() => task(item))
        .catch((error) => { failure ??= { error }; })
        .finally(() => { active.delete(key); });
      active.set(key, operation);
    }
    if (active.size) await Promise.race([...active.values(),waitForChange()]);
  }
  if (failure) throw failure.error;
}

function userSafeError(error: unknown): string {
  if (error instanceof Error) return redactDiagnosticMessage(error.message);
  return "发生未知同步错误。";
}
