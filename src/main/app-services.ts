import { ReaderConversionClient } from "./reader-conversion-client";
import { ArticleLibrary } from "./article-library";
import { RewriteService } from "./rewrite-service";
import { AcademicAuthorConnector } from "./academic";
import { AiService } from "./ai-service";
import { ArticleReader } from "./article-reader";
import { ContentMaintenance } from "./content-maintenance";
import { ConnectorRegistry } from "./connector-registry";
import { GenericConnector, ManualConnector, RssConnector } from "./connectors";
import { ReadingDatabase } from "./database";
import { InAppArticleViewer } from "./in-app-article-viewer";
import { NETWORK_REQUEST_MESSAGES, PublicHttpClient } from "./http";
import { configureChromiumNetwork } from "./network";
import { ManagedPageRenderer } from "./render-worker-pool";
import { RobotsNetworkUnavailableError, RobotsPolicy, RobotsUnreachableError } from "./robots";
import { net } from "electron";
import { SecretStore } from "./secrets";
import { SourceProbe } from "./source-probe";
import { SourceService } from "./source-service";
import { SyncManager } from "./sync-manager";
import { ZhihuConnector } from "./zhihu";
import { ZhihuFollowConnector } from "./zhihu-follow";
import { StorageWorkerClient } from "./storage-worker-client";

/** Main-process dependencies assembled once at application startup. */
export interface ApplicationServices {
  database: ReadingDatabase;
  http: PublicHttpClient;
  secrets: SecretStore;
  sources: SourceService;
  sync: SyncManager;
  maintenance: ContentMaintenance;
  academic: AcademicAuthorConnector;
  learningAssistant: AiService;
  rewrites: RewriteService;
  articles: ArticleLibrary;
  inAppArticleViewer: InAppArticleViewer;
  beginShutdown(): void;
  close(): Promise<void>;
}

/**
 * Keeps composition separate from Electron window lifecycle and IPC routing.
 * Service constructors stay dependency-injected, which makes connector and
 * sync behaviour independently testable without a BrowserWindow.
 */
export async function createApplicationServices(databasePath: string): Promise<ApplicationServices> {
  await configureChromiumNetwork();
  const database = new ReadingDatabase(databasePath);
  let services: ApplicationServices | undefined;
  try {
    services = assembleApplicationServices(database, databasePath);
    const resumed = await database.write("resumeLegacyAutoPausedSources");
    if(resumed)console.info(`Reading Hub 已恢复 ${resumed} 个因旧版临时失败而停滞的自动来源。`);
    await database.write("rescheduleLegacyRobotsFailure",new RobotsUnreachableError().message);
    const report=await database.write("runStartupMaintenance");
    if(report.failures.length)console.warn(`Reading Hub 未完成 ${report.failures.length} 项本地历史内容维护；将在下次启动时重试。`);
    await database.write("beginLibrarySession");
    await services.sources.removeUnsubscribedSources();
    if (!process.env.READING_HUB_READER_AUDIT) {
      await removeRetiredPlatformAccounts(database, services.secrets);
      await services.rewrites.start();
      await services.articles.start();
    }
    return services;
  } catch (error) {
    // Until assembly returns, no caller owns a service capable of closing
    // this connection. Failed initialization must release it here.
    try {
      if (services) await services.close();
      else database.close();
    } catch {
      console.warn("启动失败后的本地服务清理未全部完成。");
    }
    throw error;
  }
}

/** Assembly is synchronous and does not start timers, children or windows.
 * Only a fully assembled service graph takes ownership of the database. */
function assembleApplicationServices(database: ReadingDatabase, databasePath: string): ApplicationServices {
  const storage = databasePath === ":memory:" ? undefined : new StorageWorkerClient(databasePath);
  if(storage)database.setWriter(storage);
  const robots = new RobotsPolicy();
  const http = new PublicHttpClient(robots);
  const renderer = new ManagedPageRenderer(robots);
  const probe = new SourceProbe(http, renderer);
  const secrets = new SecretStore();
  const learningAssistant = new AiService(secrets);
  const rss = new RssConnector(http);
  const generic = new GenericConnector(http, renderer);
  const manual = new ManualConnector(http, renderer);
  const zhihu = new ZhihuConnector(() => secrets.getZhihuAccessSecret());
  const zhihuFollow = new ZhihuFollowConnector();
  const registry = createConnectorRegistry(rss, generic, manual, zhihu, zhihuFollow);
  const academic = new AcademicAuthorConnector();
  registry.register(academic);
  const maintenance = new ContentMaintenance(database);
  const articles = new ArticleLibrary(database, new ArticleReader(http, renderer, (url, options) => zhihuFollow.renderArticle(url, options), undefined, new ReaderConversionClient()), http,
    storage, false);
  const sync = new SyncManager(database, registry, maintenance, {
    isOnline: () => net.isOnline(),
    onRestored: () => {
      robots.forgetTransientFailures();
      void articles.onNetworkRestored().catch(() => console.warn("本地正文保存任务未能恢复，已保留待处理记录。"));
      void database.write("expediteNetworkFailures",[
        ...Object.values(RobotsNetworkUnavailableError.messages),
        // Earlier versions persisted this generic message even for offline failures.
        new RobotsUnreachableError().message,
        ...Object.values(NETWORK_REQUEST_MESSAGES)
      ]).catch(()=>console.warn("网络恢复后的同步调度未能更新，已保留原有状态。"));
    }
  }, articles);
  const sources = new SourceService(database, probe, sync, zhihuFollow, registry);

  const inAppArticleViewer = new InAppArticleViewer();
  const rewrites = new RewriteService(database, articles, learningAssistant);

  zhihuFollow.setOnAuthenticated(async () => {
    const source = await sources.ensureZhihuFollowSource();
    await articles.onSourceAuthenticated(source.id);
    await sync.syncSource(source.id);
  });

  let closePromise: Promise<void> | undefined;
  let assistantClose: Promise<void> | undefined;
  let rewriteClose: Promise<void> | undefined;
  const shutdownFailures: unknown[] = [];
  let shuttingDown = false;
  const startClose = (operation: () => void | Promise<void>): Promise<void> => {
    try { return Promise.resolve(operation()); }
    catch (error) { return Promise.reject(error); }
  };
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const stops = [
      () => inAppArticleViewer.beginShutdown(),
      () => zhihuFollow.close(),
      () => sync.beginShutdown(),
      () => articles.beginShutdown()
    ];
    for (const stop of stops) {
      try { stop(); }
      catch (error) { shutdownFailures.push(error); }
    }
    rewriteClose ??= startClose(() => rewrites.close());
    assistantClose ??= startClose(() => learningAssistant.close());
    // Begin cleanup before the IPC drain; retain any failure for close().
    void assistantClose.catch(() => undefined);
    void rewriteClose.catch(() => undefined);
  };
  // Failed service assembly is not a library visit. Advance this boundary
  // only after assembly succeeds, so the next launch still sees new arrivals.
  return {
    database,
    http,
    secrets,
    sources,
    sync,
    maintenance,
    academic,
    learningAssistant,
    rewrites,
    articles,
    inAppArticleViewer,
    beginShutdown,
    close: () => {
      beginShutdown();
      closePromise ??= (async () => {
        const outcomes = await Promise.allSettled([
          startClose(() => sync.close()), assistantClose!, rewriteClose!,
          startClose(() => articles.close()), startClose(() => inAppArticleViewer.close())
        ]);
        try { await storage?.close(); }
        catch (error) { shutdownFailures.push(error); }
        finally {
          try { database.close(); }
          catch (error) { shutdownFailures.push(error); }
        }
        if (shutdownFailures.length || outcomes.some(result => result.status === "rejected")) {
          throw new Error("本地服务未能完整关闭。");
        }
      })();
      return closePromise;
    }
  };
}

/** Schema migration detaches retired sources first. Keep a failed cleanup's
 * Keychain reference for a later launch, without blocking unrelated services.
 * Never run this against an audit copy of the user's database. */
async function removeRetiredPlatformAccounts(database: ReadingDatabase, secrets: SecretStore): Promise<void> {
  let failures = 0;
  for (const connectorId of ["x", "xiaohongshu"]) {
    for (const account of database.listAccounts(connectorId)) {
      try {
        // A damaged legacy record must not target another provider's secret.
        if (account.keychainAccount && !account.keychainAccount.startsWith(`${connectorId}:`)) {
          throw new Error("旧授权引用不属于已移除的连接器。");
        }
        await secrets.clearConnectorSecret(account.keychainAccount);
        await database.write("deleteAccount",account.id);
      } catch {
        failures += 1;
      }
    }
  }
  if (failures) console.warn(`Reading Hub 未完成 ${failures} 项旧授权清理；将在下次启动时重试。`);
}

function createConnectorRegistry(rss: RssConnector, generic: GenericConnector, manual: ManualConnector, zhihu: ZhihuConnector, zhihuFollow: ZhihuFollowConnector): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  for (const connector of [rss, generic, manual, zhihu, zhihuFollow]) registry.register(connector);
  return registry;
}
