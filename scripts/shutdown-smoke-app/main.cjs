const { app, BrowserWindow, Menu } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { createShutdownHandler } = require("../../dist/main/main/shutdown.js");
const { registerIpcHandlers } = require("../../dist/main/main/ipc-handlers.js");
const { ReadingDatabase } = require("../../dist/main/main/database.js");
const mode = process.env.READING_HUB_SHUTDOWN_CASE || "idle";
app.setPath("userData", path.join(tmpdir(), `reading-hub-shutdown-${process.pid}`));
app.on("window-all-closed", () => {});
let closed = false, closes = 0, cancelled = false, requested = false, startedAt;
let database, drain, startup;
const watchdog = setTimeout(() => { console.error(`Single-click quit stalled: ${mode}`); app.exit(1); }, 10_000);
const onQuit = createShutdownHandler(async () => {
  closes++;
  await startup;
  await drain();
  database.close();
  closed = true;
}, () => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  setImmediate(() => app.quit());
}, () => app.exit(1));
app.on("before-quit", onQuit);
app.on("quit", () => {
  clearTimeout(watchdog);
  assert(closed && closes === 1, "Cleanup must finish exactly once before exit.");
  if (mode === "busy") assert(cancelled, "Pending IPC must be cancelled and drained.");
  assert(Date.now() - startedAt < 5_000, "A second menu click must not be needed.");
  console.log(`Single-click shutdown passed: ${mode}`);
});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, focusable: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.resolve(__dirname, "../../dist/main/main/preload.js")
  } });
  await window.loadURL("about:blank");
  if (mode === "unload") await window.webContents.executeJavaScript("window.onbeforeunload = () => false; void 0");
  startup = (async () => {
    if (mode === "startup") await delay(100);
    database = new ReadingDatabase(":memory:");
    drain = registerIpcHandlers({ database, sources: {
      preview: (_url, signal) => new Promise(resolve => {
        requested = true;
        signal.addEventListener("abort", () => {
          cancelled = true;
          // Simulate an already-admitted write finishing before SQLite closes.
          setTimeout(() => { database.getLibraryRevision(); resolve({}); }, 25);
        }, { once: true });
      })
    } });
  })();
  if (mode !== "startup") await startup;
  if (mode === "busy") {
    await window.webContents.executeJavaScript("window.reader.previewSource('https://example.com/fixture').catch(() => {}); void 0");
    while (!requested) await delay(5);
  }
  const menu = Menu.buildFromTemplate([{ label: "退出", click: () => app.quit() }]);
  startedAt = Date.now();
  menu.items[0].click();
}).catch(error => { console.error(error); app.exit(1); });
