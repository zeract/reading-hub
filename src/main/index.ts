import path from "node:path";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage } from "electron";
import { IPC_CHANNELS } from "../shared/ipc";
import { createApplicationServices, type ApplicationServices } from "./app-services";
import { registerIpcHandlers } from "./ipc-handlers";
import { configureChromiumNetwork } from "./network";
import { auditLocalReader, type ReaderAuditProgress, type ReaderAuditResult } from "./reader-audit";
import { ScientificArticleVisualAuditor } from "./scientific-visual-audit";
import { installDevelopmentSupervisorGuard } from "./dev-supervisor";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let services: ApplicationServices | undefined;
let quitting = false;

const APPLICATION_NAME = "Reading Hub";
const USER_DATA_DIRECTORY = "reading-hub";
const readerAuditMode = process.env.READING_HUB_READER_AUDIT === "1";
const scientificVisualAuditMode = readerAuditMode && process.env.READING_HUB_AUDIT_SCIENTIFIC_VISUAL === "1";
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

function quitApplication(): void {
  if (quitting) return;
  quitting = true;
  app.quit();
}

/**
 * SQLite must outlive every renderer IPC request that Electron drains while a
 * window is closing. `before-quit` runs before that drain has finished; in
 * development a main-process rebuild therefore used to close the database
 * while the outgoing renderer was still requesting its initial source list.
 * `will-quit` is emitted only after windows have been closed, so it is the
 * safe final boundary for releasing main-process services.
 */
function closeApplicationServices(): void {
  const activeServices = services;
  services = undefined;
  activeServices?.close();
}

// `scripts/dev.mjs` terminates Electron when the compiled main process changes.
// On macOS, window close normally hides this menu-bar app, so translate terminal
// signals into an explicit app quit instead of leaving a hidden lock owner.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, quitApplication);

// The development launcher provides an IPC parent channel. Unlike a PID
// check, its closure cannot be confused by PID reuse after a terminal crash.
// Keep this strictly development-only: production apps are intentionally
// allowed to remain resident in the macOS menu bar after their window closes.
if (isDevelopment) installDevelopmentSupervisorGuard(process, quitApplication);

// Mark shutdown at the earliest lifecycle signal, but defer resource release
// until Electron has finished closing every renderer. Keeping these listeners
// outside bootstrap also covers a quit request that races startup.
app.on("before-quit", () => {
  quitting = true;
});
app.once("will-quit", closeApplicationServices);

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
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.window.fullscreenChanged, window.isFullScreen());
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
      { label: "退出", click: quitApplication }
    ])
  );
  tray.on("click", showWindow);
}

async function bootstrap(): Promise<void> {
  const icon = applicationIcon();
  if (process.platform === "darwin" && !icon.isEmpty()) app.dock?.setIcon(icon);
  services = await createApplicationServices(path.join(app.getPath("userData"), "reading-hub.sqlite"));
  registerIpcHandlers(services);
  createTray();
  showWindow();
  services.sync.start();

  app.on("activate", showWindow);
}

async function runReaderAudit(): Promise<void> {
  await configureChromiumNetwork();
  const databasePath = process.env.READING_HUB_DB_PATH || path.join(persistentUserDataPath, "reading-hub.sqlite");
  const reportPath = process.env.READING_HUB_AUDIT_REPORT;
  const progress = {
    startedAt: new Date().toISOString(),
    completed: 0,
    total: 0,
    current: undefined as ReaderAuditProgress | undefined,
    results: [] as ReaderAuditResult[]
  };
  let pendingProgressWrite = Promise.resolve();
  const writeProgress = async () => {
    if (!reportPath) return;
    // Heartbeats are intentionally fire-and-forget so a slow report disk does
    // not hold up cancellation. Serialize their snapshots here so an older
    // heartbeat can never overwrite a later finished result.
    const snapshot = JSON.stringify({
      ...progress,
      current: progress.current ? { ...progress.current } : undefined,
      results: [...progress.results],
      updatedAt: new Date().toISOString()
    }, null, 2);
    pendingProgressWrite = pendingProgressWrite.catch(() => undefined).then(() => writeFile(`${reportPath}.progress.json`, snapshot, "utf8"));
    await pendingProgressWrite;
  };
  if (reportPath) {
    await writeFile(`${reportPath}.starting`, `${progress.startedAt}\n`, "utf8");
    await writeProgress();
  }
  // Keep Electron's event loop alive between isolated page windows. Without a
  // persistent host window macOS may terminate this headless audit after the
  // first renderer window closes, before the report is flushed.
  const auditHost = new BrowserWindow({ show: false });
  const scientificVisualAuditor = scientificVisualAuditMode ? new ScientificArticleVisualAuditor() : undefined;
  try {
    const report = JSON.stringify(await auditLocalReader(databasePath, {
      onProgress: async (event) => {
        progress.completed = event.completed;
        progress.total = event.total;
        progress.current = event;
        await writeProgress();
      },
      onResult: async (result) => {
        progress.results.push(result);
        await writeProgress();
      },
      inspectLayout: scientificVisualAuditor
        ? (article) => scientificVisualAuditor.inspect(article)
        : undefined
    }), null, 2);
    if (reportPath) await writeFile(reportPath, report, "utf8");
    console.log(report);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : "未知错误";
    if (reportPath) await writeFile(reportPath, JSON.stringify([{ source: "审计执行", kind: "generic", issues: [message] }], null, 2), "utf8");
    throw error;
  } finally {
    await scientificVisualAuditor?.close();
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
    }
    dialog.showErrorBox("Reading Hub 无法启动", `${message}\n\n请运行 npm run rebuild:electron 后重试。`);
    app.exit(1);
  }).finally(() => {
    if (readerAuditMode) app.quit();
  });
}
