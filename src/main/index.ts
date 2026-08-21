import path from "node:path";
import { readFileSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from "electron";
import { ReadingDatabase } from "./database";
import { sourceFaviconCandidate } from "../shared/source-icon";
import { GenericConnector, ManualConnector, RssConnector } from "./connectors";
import { builtInManifest, CallbackConnectorAdapter, ConnectorRegistry, LegacyConnectorAdapter } from "./connector-registry";
import { PublicHttpClient } from "./http";
import { configureChromiumNetwork } from "./network";
import { IsolatedPageRenderer } from "./page-renderer";
import { SecretStore } from "./secrets";
import { SourceProbe } from "./source-probe";
import { SourceService } from "./source-service";
import { SyncManager } from "./sync-manager";
import { ZhihuConnector } from "./zhihu";
import { ZhihuFollowConnector } from "./zhihu-follow";
import { XConnector } from "./x";
import { XiaohongshuConnector } from "./xiaohongshu";
import { AcademicAuthorConnector } from "./academic";
import { AiService } from "./ai-service";
import { ArticleReader } from "./article-reader";
import { InAppArticleViewer } from "./in-app-article-viewer";
import { auditLocalReader } from "./reader-audit";
import { assertPublicUrl } from "../shared/url";
import { RobotsDisallowedError } from "./robots";
import type { AiProviderConfiguration, AiStreamEvent, AiStreamRequest, EntryListQuery, ExtractionRule, OpmlImportResult, ProfileSubscriptionInput, Source, SourceSettings, SyncResult } from "../shared/types";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
const APPLICATION_NAME = "Reading Hub";
const USER_DATA_DIRECTORY = "reading-hub";
const readerAuditMode = process.env.READING_HUB_READER_AUDIT === "1";
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

// A failed public-source request is represented in the source health UI and
// scheduled for retry. Chromium also writes one low-level TLS line for every
// failed connection, which can turn an ordinary offline/proxy outage into an
// unreadable development terminal. Keep application errors intact while
// suppressing only Chromium's verbose network diagnostics by default. Set
// READING_HUB_VERBOSE_CHROMIUM_LOGS=1 when debugging Chromium itself.
if (isDevelopment && process.env.READING_HUB_VERBOSE_CHROMIUM_LOGS !== "1") {
  app.commandLine.appendSwitch("log-level", "3");
}

// productName only applies after packaging. Set the runtime identity as well so
// macOS never presents the development binary as “Electron” in its menus.
// Keep the legacy data directory so a branding change never hides the user's
// existing sources, reading state, local sessions, or Keychain references.
app.setName(APPLICATION_NAME);
const persistentUserDataPath = path.join(app.getPath("appData"), USER_DATA_DIRECTORY);
// Reader audits deliberately run alongside a development instance. Chromium
// otherwise aborts before auditing because both processes contend for the
// profile's SingletonLock. The audit still reads the normal database below;
// only its transient Electron profile is isolated in the OS temp directory.
app.setPath("userData", readerAuditMode
  ? path.join(app.getPath("temp"), `reading-hub-reader-audit-${process.pid}`)
  : persistentUserDataPath);
process.title = APPLICATION_NAME;

function applicationIcon() {
  try {
    const svg = readFileSync(path.join(app.getAppPath(), "assets", "reading-hub-icon.svg"), "utf8");
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    if (!icon.isEmpty()) return icon;
  } catch {
    // The SVG retains transparent corners. The discarded raster preview made
    // those corners opaque white in the Dock during development.
  }
  return nativeImage.createEmpty();
}

function isAiStreamRequest(value: unknown): value is AiStreamRequest {
  if (!value || typeof value !== "object") return false;
  const requestId = (value as { requestId?: unknown }).requestId;
  const request = (value as { request?: unknown }).request;
  const article = request && typeof request === "object" ? (request as { article?: unknown }).article : undefined;
  const selection = request && typeof request === "object" ? (request as { selection?: unknown }).selection : undefined;
  return typeof requestId === "string"
    && /^[A-Za-z0-9_-]{8,80}$/.test(requestId)
    && Boolean(request && typeof request === "object")
    && ["openai", "deepseek", "codex-cli"].includes((request as { provider?: unknown }).provider as string)
    && typeof (request as { question?: unknown }).question === "string"
    && Boolean(article && typeof article === "object")
    && typeof (article as { title?: unknown }).title === "string"
    && typeof (article as { url?: unknown }).url === "string"
    && typeof (article as { text?: unknown }).text === "string"
    && (selection === undefined || Boolean(selection && typeof selection === "object"
      && typeof (selection as { text?: unknown }).text === "string"
      && ["translate", "explain", "ask"].includes((selection as { intent?: unknown }).intent as string)));
}

function isProfileSubscriptionInput(value: unknown): value is ProfileSubscriptionInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<ProfileSubscriptionInput>;
  return typeof input.url === "string"
    && (input.title === undefined || typeof input.title === "string");
}

function quitApplication(): void {
  if (quitting) return;
  quitting = true;
  app.quit();
}

// `scripts/dev.mjs` terminates Electron when the compiled main process changes.
// On macOS, window close normally hides this menu-bar app, so translate terminal
// signals into an explicit app quit instead of leaving a hidden lock owner.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, quitApplication);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    title: APPLICATION_NAME,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    icon: applicationIcon(),
    backgroundColor: "#f6f6f2",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const publishFullscreenState = () => {
    if (!window.isDestroyed()) window.webContents.send("window:fullscreen-changed", window.isFullScreen());
  };
  window.on("enter-full-screen", publishFullscreenState);
  window.on("leave-full-screen", publishFullscreenState);
  window.webContents.on("did-finish-load", publishFullscreenState);
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  window.on("close", (event) => {
    if (!quitting) {
      if (isDevelopment) {
        event.preventDefault();
        quitApplication();
        return;
      }
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function showWindow(): void {
  if (!mainWindow) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  const icon = applicationIcon().resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip(APPLICATION_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `打开 ${APPLICATION_NAME}`, click: showWindow },
      {
        label: "退出",
        click: () => {
          quitApplication();
        }
      }
    ])
  );
  tray.on("click", showWindow);
}

async function bootstrap(): Promise<void> {
  const icon = applicationIcon();
  if (process.platform === "darwin" && !icon.isEmpty()) app.dock?.setIcon(icon);
  await configureChromiumNetwork();
  const database = new ReadingDatabase(path.join(app.getPath("userData"), "reading-hub.sqlite"));
  const http = new PublicHttpClient();
  const renderer = new IsolatedPageRenderer();
  const probe = new SourceProbe(http, renderer);
  const secrets = new SecretStore();
  const learningAssistant = new AiService(secrets);
  const rss = new RssConnector(http, probe);
  const generic = new GenericConnector(http, probe, renderer);
  const manual = new ManualConnector(http, probe, renderer);
  const zhihu = new ZhihuConnector(() => secrets.getZhihuAccessSecret());
  const zhihuFollow = new ZhihuFollowConnector();
  const registry = new ConnectorRegistry();
  registry.register(new LegacyConnectorAdapter(
    builtInManifest("rss", "RSS / Atom / JSON Feed", ["public-http"], []),
    (source) => rss.fetchWithMetadata(source),
    (entry, source) => rss.normalize(entry, source)
  ));
  registry.register(new LegacyConnectorAdapter(
    builtInManifest("generic", "公开网页", ["public-http"], []),
    (source) => generic.fetchWithMetadata(source),
    (entry, source) => generic.normalize(entry, source)
  ));
  registry.register(new LegacyConnectorAdapter(
    builtInManifest("manual", "分享链接", ["public-http"], []),
    (source) => manual.fetchWithMetadata(source),
    (entry, source) => manual.normalize(entry, source)
  ));
  registry.register(new CallbackConnectorAdapter(
    builtInManifest("zhihu", "知乎（官方数据）", ["oauth"], ["developer.zhihu.com"]),
    async () => ({ entries: await zhihu.fetchEntries(), emptyIsHealthy: true }),
    (entry, source) => generic.normalize(entry, source)
  ));
  registry.register(new CallbackConnectorAdapter(
    builtInManifest("zhihu_follow", "知乎关注动态", ["oauth"], ["www.zhihu.com"]),
    async () => ({ entries: await zhihuFollow.fetchEntries(), emptyIsHealthy: true }),
    (entry, source) => generic.normalize(entry, source)
  ));
  const x = new XConnector(database, secrets);
  const xiaohongshu = new XiaohongshuConnector(http);
  const academic = new AcademicAuthorConnector();
  registry.register(x);
  registry.register(xiaohongshu);
  registry.register(academic);
  const articles = new ArticleReader(http, renderer, (url) => zhihuFollow.renderArticle(url));
  const inAppArticleViewer = new InAppArticleViewer();
  let zhihuSecondarySync: Promise<void> | undefined;
  const afterSync = async (source: Source, _result: SyncResult): Promise<void> => {
    if (source.kind === "zhihu_follow") {
      database.deleteUnsupportedZhihuFollowEntries(source.id);
      database.deletePromotedZhihuFollowEntries(source.id);
      return;
    }
    if ((source.connectorId ?? source.kind) !== "zhihu" || zhihuSecondarySync) return;
    zhihuSecondarySync = (async () => {
      const [collections, followees] = await Promise.allSettled([zhihu.fetchRecentCollections(), zhihu.fetchFollowees()]);
      if (collections.status === "fulfilled") {
        const storedSource = database.getSource(source.id);
        if (storedSource) database.saveEntries(collections.value.map((entry) => generic.normalize(entry, storedSource)));
      }
      if (followees.status === "fulfilled") database.upsertFollowees(followees.value);
    })().finally(() => { zhihuSecondarySync = undefined; });
    void zhihuSecondarySync;
  };
  const sync = new SyncManager(database, registry, afterSync);
  const sources = new SourceService(database, probe, sync, zhihuFollow);
  sources.retireUnsupportedXPublicProfileSources();
  // Older builds could save Zhihu ideas (/pin/) before the Follow parser was
  // narrowed to authored posts. Remove only those known legacy activities on
  // startup; ordinary answers and columns stay untouched.
  for (const source of database.listSources()) {
    if ((source.connectorId ?? source.kind) === "rss") database.repairScourRedirectEntries(source.id);
    if ((source.connectorId ?? source.kind) === "generic") database.repairGenericHomepageEntryUrls(source);
    if (source.kind === "zhihu_follow") {
      database.deleteUnsupportedZhihuFollowEntries(source.id);
      database.deletePromotedZhihuFollowEntries(source.id);
    }
  }
  zhihuFollow.setOnAuthenticated(async () => {
    const source = sources.ensureZhihuFollowSource();
    await sync.syncSource(source.id);
  });

  ipcMain.handle("source:preview", (_event, url: string) => sources.preview(url));
  ipcMain.handle("source:confirm", (_event, token: string) => sources.confirm(token));
  ipcMain.handle("source:import-opml", async (event): Promise<OpmlImportResult> => {
    const options = {
      title: "导入 OPML 订阅",
      properties: ["openFile"] as Array<"openFile">,
      filters: [{ name: "OPML 订阅", extensions: ["opml", "xml"] }]
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const selection = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true, imported: 0, existing: 0, skipped: 0 };
    const filePath = selection.filePaths[0];
    const file = await lstat(filePath);
    if (!file.isFile() || file.size > 2_000_000) throw new Error("OPML 文件必须是小于 2 MB 的普通文件。");
    const text = await readFile(filePath, "utf8");
    return { cancelled: false, ...sources.importOpml(text) };
  });
  ipcMain.handle("source:list", () => database.listSources());
  ipcMain.handle("source:delete", (_event, id: string) => sources.delete(id));
  ipcMain.handle("source:refresh", async (_event, id: string) => sync.syncSource(id));
  ipcMain.handle("source:update-settings", (_event, id: string, settings: SourceSettings) => sources.updateSettings(id, settings));
  ipcMain.handle("source:update-rule", (_event, id: string, rule: ExtractionRule) => database.updateRule(id, rule));
  ipcMain.handle("source:calibration", (_event, id: string) => sources.calibrate(id));
  ipcMain.handle("entry:list", (_event, query?: EntryListQuery) => database.listEntries(query));
  ipcMain.handle("entry:counts", () => database.getLibraryCounts());
  ipcMain.handle("entry:read-content", async (_event, entryId: string) => {
    const entry = database.getEntry(entryId);
    if (!entry) throw new Error("这篇内容已不存在。请刷新列表后重试。");
    try {
      return { kind: "article", article: await articles.read(entry, database.getSource(entry.sourceId)) };
    } catch (error) {
      if (!(error instanceof RobotsDisallowedError)) throw error;
      await inAppArticleViewer.open(entry.url, entry.title);
      return { kind: "embedded" };
    }
  });
  ipcMain.handle("entry:open-embedded", async (_event, entryId: string) => {
    const entry = database.getEntry(entryId);
    if (!entry) throw new Error("这篇内容已不存在。请刷新列表后重试。");
    await inAppArticleViewer.open(entry.url, entry.title);
  });
  ipcMain.handle("entry:load-image", async (_event, entryId: string, imageUrl: string) => {
    const entry = database.getEntry(entryId);
    if (!entry) throw new Error("这篇内容已不存在。请刷新列表后重试。");
    return http.getImageDataUrl(imageUrl, entry.url);
  });
  ipcMain.handle("source:load-icon", async (_event, sourceId: string) => {
    const source = database.getSource(sourceId);
    if (!source) return undefined;
    const iconUrl = sourceFaviconCandidate(source);
    if (!iconUrl) return undefined;
    try {
      return await http.getImageDataUrl(iconUrl, source.url);
    } catch {
      // A favicon is decorative. It must never make a source appear broken,
      // and the renderer will use its local platform/type icon instead.
      return undefined;
    }
  });
  ipcMain.handle("entry:read", (_event, id: string, read: boolean) => database.markRead(id, read));
  ipcMain.handle("entry:favorite", (_event, id: string, favorite: boolean) => database.markFavorite(id, favorite));
  ipcMain.handle("entry:dismiss", (_event, id: string) => database.dismissEntry(id));
  ipcMain.handle("ai:list-providers", () => learningAssistant.listProviders());
  ipcMain.handle("ai:configure", (_event, configuration: AiProviderConfiguration) => learningAssistant.configure(configuration));
  ipcMain.handle("ai:clear-provider", (_event, provider: AiProviderConfiguration["provider"]) => learningAssistant.clear(provider));
  ipcMain.handle("ai:ask-stream", (event, payload: AiStreamRequest) => {
    if (!isAiStreamRequest(payload)) throw new Error("AI 流式请求无效，请重新发送问题。");
    const emit = (update: AiStreamEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send("ai:stream", update);
    };
    // Start only after the invoke handler returns. The renderer has already
    // registered its supplied id, so its first token can never be lost.
    queueMicrotask(() => {
      void learningAssistant.askStream(payload.request, (text) => emit({ type: "delta", requestId: payload.requestId, text }))
        .then((answer) => emit({ type: "complete", requestId: payload.requestId, answer }))
        .catch((error: unknown) => emit({
          type: "error",
          requestId: payload.requestId,
          message: error instanceof Error && error.message ? error.message : "AI 学习助手暂时无法完成回答，请稍后重试。"
        }));
    });
    return { requestId: payload.requestId };
  });
  ipcMain.handle("window:is-fullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  ipcMain.handle("app:open-external", (_event, url: string) => shell.openExternal(assertPublicUrl(url).toString()));
  ipcMain.handle("zhihu:connect", async (_event, accessSecret: string) => {
    await secrets.setZhihuAccessSecret(accessSecret);
    const source = sources.connectZhihu();
    return sync.syncSource(source.id);
  });
  ipcMain.handle("zhihu:follow-login", () => sources.beginZhihuFollowLogin());
  ipcMain.handle("x:connect", async (_event, clientId: string) => {
    const account = await x.authorizeWithClientId(clientId);
    const source = sources.ensureXSource(account);
    return sync.syncSource(source.id);
  });
  ipcMain.handle("xiaohongshu:subscribe-profile", async (_event, input: unknown) => {
    if (!isProfileSubscriptionInput(input)) throw new Error("小红书博主主页参数无效，请重新填写。");
    const source = sources.createXiaohongshuProfileSource(input);
    return (await sync.syncSource(source.id)).source;
  });
  ipcMain.handle("academic:search", (_event, query: string) => academic.discover(query));
  ipcMain.handle("academic:subscribe", async (_event, draft: { title: string; targetId?: string; config?: Record<string, unknown> }) => {
    const source = sources.createAcademicSource(draft);
    return sync.syncSource(source.id);
  });

  createTray();
  showWindow();
  sync.start();

  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    sync.stop();
    database.close();
  });
}

async function runReaderAudit(): Promise<void> {
  await configureChromiumNetwork();
  const databasePath = process.env.READING_HUB_DB_PATH || path.join(persistentUserDataPath, "reading-hub.sqlite");
  const reportPath = process.env.READING_HUB_AUDIT_REPORT;
  if (reportPath) await writeFile(`${reportPath}.starting`, `${new Date().toISOString()}\n`, "utf8");
  // Keep Electron's event loop alive between isolated page windows. Without a
  // persistent host window macOS may terminate this headless audit after the
  // first renderer window closes, before the report is flushed.
  const auditHost = new BrowserWindow({ show: false });
  try {
    const report = JSON.stringify(await auditLocalReader(databasePath), null, 2);
    if (reportPath) await writeFile(reportPath, report, "utf8");
    console.log(report);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : "未知错误";
    if (reportPath) await writeFile(reportPath, JSON.stringify([{ source: "审计执行", kind: "generic", issues: [message] }], null, 2), "utf8");
    throw error;
  } finally {
    if (!auditHost.isDestroyed()) auditHost.destroy();
  }
}

// Development restarts can overlap briefly on macOS. Only the first app may
// own the UI; a subsequent invocation focuses it and exits instead of opening
// another Reading Hub window. Audits deliberately bypass this lock so they can
// run as isolated, read-only release checks.
const ownsReaderInstance = readerAuditMode || app.requestSingleInstanceLock();

if (!ownsReaderInstance) {
  app.quit();
} else {
  if (!readerAuditMode) app.on("second-instance", showWindow);
  const startup = readerAuditMode ? runReaderAudit : bootstrap;
  app.whenReady().then(startup).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "未知启动错误";
    console.error("Reading Hub startup failed:", message);
    if (readerAuditMode && process.env.READING_HUB_AUDIT_REPORT) {
      await writeFile(process.env.READING_HUB_AUDIT_REPORT, JSON.stringify([{ source: "审计启动", kind: "generic", issues: [message] }], null, 2), "utf8").catch(() => undefined);
      // `app.exit()` terminates native I/O immediately on macOS. Let the shared
      // audit-mode finalizer close the process after the diagnostic has flushed.
      return;
    } else {
      dialog.showErrorBox("Reading Hub 无法启动", `${message}\n\n请运行 npm run rebuild:electron 后重试。`);
    }
    app.exit(1);
  }).finally(() => {
    if (readerAuditMode) app.quit();
  });
}
