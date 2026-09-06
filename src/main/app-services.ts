import { AcademicAuthorConnector } from "./academic";
import { AiService } from "./ai-service";
import { ArticleReader } from "./article-reader";
import { ContentMaintenance } from "./content-maintenance";
import { ConnectorRegistry } from "./connector-registry";
import { GenericConnector, ManualConnector, RssConnector } from "./connectors";
import { ReadingDatabase } from "./database";
import { InAppArticleViewer } from "./in-app-article-viewer";
import { PublicHttpClient } from "./http";
import { configureChromiumNetwork } from "./network";
import { IsolatedPageRenderer } from "./page-renderer";
import { SecretStore } from "./secrets";
import { SourceProbe } from "./source-probe";
import { SourceService } from "./source-service";
import { SyncManager } from "./sync-manager";
import { XConnector } from "./x";
import { XiaohongshuConnector } from "./xiaohongshu";
import { ZhihuConnector } from "./zhihu";
import { ZhihuFollowConnector } from "./zhihu-follow";

/** Main-process dependencies assembled once at application startup. */
export interface ApplicationServices {
  database: ReadingDatabase;
  http: PublicHttpClient;
  secrets: SecretStore;
  sources: SourceService;
  sync: SyncManager;
  maintenance: ContentMaintenance;
  x: XConnector;
  academic: AcademicAuthorConnector;
  learningAssistant: AiService;
  articles: ArticleReader;
  inAppArticleViewer: InAppArticleViewer;
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
  database.beginLibrarySession();
  const resumedAutomaticSources = database.resumeLegacyAutoPausedSources();
  const http = new PublicHttpClient();
  const renderer = new IsolatedPageRenderer();
  const probe = new SourceProbe(http, renderer);
  const secrets = new SecretStore();
  const learningAssistant = new AiService(secrets);
  const rss = new RssConnector(http);
  const generic = new GenericConnector(http, renderer);
  const manual = new ManualConnector(http, renderer);
  const zhihu = new ZhihuConnector(() => secrets.getZhihuAccessSecret());
  const zhihuFollow = new ZhihuFollowConnector();
  const registry = createConnectorRegistry(rss, generic, manual, zhihu, zhihuFollow);
  const x = new XConnector({
    findAccount: database.findAccount.bind(database),
    saveAccount: database.saveAccount.bind(database),
    updateAccountStatus: database.updateAccountStatus.bind(database)
  }, {
    getConnectorSecret: secrets.getConnectorSecret.bind(secrets),
    setConnectorSecret: secrets.setConnectorSecret.bind(secrets)
  });
  const xiaohongshu = new XiaohongshuConnector(http);
  const academic = new AcademicAuthorConnector();
  registry.register(x);
  registry.register(xiaohongshu);
  registry.register(academic);
  const maintenance = new ContentMaintenance(database);
  const sync = new SyncManager(database, registry, maintenance);
  const sources = new SourceService(database, probe, sync, zhihuFollow, registry);
  const articles = new ArticleReader(http, renderer, (url, options) => zhihuFollow.renderArticle(url, options));
  const inAppArticleViewer = new InAppArticleViewer();

  sources.retireUnsupportedXPublicProfileSources();
  if (resumedAutomaticSources) {
    // Count only: never log source URLs, titles or remote error payloads.
    console.info(`Reading Hub 已恢复 ${resumedAutomaticSources} 个因旧版临时失败而停滞的自动来源。`);
  }
  const maintenanceReport = maintenance.runStartupMaintenance();
  if (maintenanceReport.failures.length) {
    // Deliberately omit URLs, article text and identifiers from logs. A later
    // startup can retry any source whose marker was not successfully written.
    console.warn(`Reading Hub 未完成 ${maintenanceReport.failures.length} 项本地历史内容维护；将在下次启动时重试。`);
  }
  zhihuFollow.setOnAuthenticated(async () => {
    const source = sources.ensureZhihuFollowSource();
    await sync.syncSource(source.id);
  });

  let closePromise: Promise<void> | undefined;
  return {
    database,
    http,
    secrets,
    sources,
    sync,
    maintenance,
    x,
    academic,
    learningAssistant,
    articles,
    inAppArticleViewer,
    close: () => {
      // Login recognition can finish after its window has closed. Detach its
      // source-creation callback before draining the already-running syncs.
      zhihuFollow.setOnAuthenticated(async () => undefined);
      closePromise ??= sync.close().then(() => database.close());
      return closePromise;
    }
  };
}

function createConnectorRegistry(rss: RssConnector, generic: GenericConnector, manual: ManualConnector, zhihu: ZhihuConnector, zhihuFollow: ZhihuFollowConnector): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  for (const connector of [rss, generic, manual, zhihu, zhihuFollow]) registry.register(connector);
  return registry;
}
