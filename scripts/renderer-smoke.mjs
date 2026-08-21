import path from "node:path";
import { tmpdir } from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";

const root = path.resolve(import.meta.dirname, "..");
const preload = path.join(root, "dist", "main", "main", "preload.js");
const renderer = path.join(root, "dist", "renderer", "index.html");
const channels = [
  ["source:list", () => []],
  ["entry:list", () => []],
  ["entry:counts", () => ({ unread: 0, favorite: 0, today: 0 })],
  ["window:is-fullscreen", () => false]
];

app.setPath("userData", path.join(tmpdir(), `reading-hub-renderer-smoke-${process.pid}`));

// A native Electron initialization issue must fail this diagnostic rather than
// leaving a terminal (or CI worker) alive indefinitely before `whenReady()`.
const startupWatchdog = setTimeout(() => {
  console.error("Reading Hub renderer smoke test timed out while Electron was starting.");
  // `app.exit()` can itself wait indefinitely when the native app never
  // reached readiness. This is a diagnostic-only process, so force the
  // watchdog outcome instead of retaining a stuck Electron helper.
  process.exit(1);
}, 15_000);

function waitFor(window, expression, timeout = 8_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = async () => {
      try {
        if (await window.webContents.executeJavaScript(expression)) return resolve();
      } catch {
        // Keep polling until the renderer either mounts or gives us a useful timeout.
      }
      if (Date.now() >= deadline) return reject(new Error("渲染器未在限定时间内挂载应用外壳。"));
      setTimeout(poll, 50);
    };
    void poll();
  });
}

await app.whenReady();
for (const [channel, handler] of channels) ipcMain.handle(channel, handler);

const messages = [];
const preloadErrors = [];
const window = new BrowserWindow({
  show: false,
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
});
window.webContents.on("console-message", (event) => messages.push(event.message));
window.webContents.on("preload-error", (_event, preloadPath, error) => {
  preloadErrors.push(`${preloadPath}: ${error.message}`);
});

let failure;
try {
  await window.loadFile(renderer);
  await waitFor(window, "typeof window.reader === 'object' && typeof window.reader.listSources === 'function' && Boolean(document.querySelector('.shell'))");
  const result = await window.webContents.executeJavaScript("window.reader.listSources().then((sources) => ({ sources, shell: Boolean(document.querySelector('.shell')) }))");
  if (!result.shell || !Array.isArray(result.sources)) throw new Error("预加载桥接未能完成最小 IPC 往返。");
  if (preloadErrors.length) throw new Error(`沙箱预加载加载失败：${preloadErrors.join("；")}`);
  const preloadError = messages.find((message) => /Unable to load preload script|module not found/i.test(message));
  if (preloadError) throw new Error(`沙箱预加载加载失败：${preloadError}`);
  console.log("Reading Hub renderer smoke test: passed");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  clearTimeout(startupWatchdog);
  for (const [channel] of channels) ipcMain.removeHandler(channel);
  if (!window.isDestroyed()) window.destroy();
}

// `app.quit()` waits for all macOS application lifecycle work to settle. That
// is useful for the product, but makes a hidden, single-purpose smoke process
// occasionally linger after its window has closed. The test has finished all
// asynchronous work at this point, so exit explicitly and deterministically.
app.exit(failure ? 1 : 0);
