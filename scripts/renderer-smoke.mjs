import path from "node:path";
import { tmpdir } from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { ReadingDatabase } from "../dist/main/main/database.js";

const root = path.resolve(import.meta.dirname, "..");
const preload = path.join(root, "dist", "main", "main", "preload.js");
const renderer = path.join(root, "dist", "renderer", "index.html");
const database = new ReadingDatabase(":memory:");
const source = database.createSource({ url: "https://example.com/feed", title: "Workflow fixture", kind: "rss", pollingEnabled: true });
for (const [id, title, ingestionKind] of [["success", "Readable fixture", "current"], ["failure", "Unavailable fixture", "current"], ["history", "Historical fixture", "history"]]) {
  database.saveEntries([{ id, sourceId: source.id, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`, title,
    ingestionKind, contentHash: id, createdAt: Date.now(), read: false, favorite: false }]);
}
database.markFavorite("success", true);
const fixtureImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
let pauseImages = false;
let imageLoads = 0;
let pendingImage;
let imageRequested;
const cancelledImages = new Set();
const channels = [
  ["library:revision", () => database.getLibraryRevision()],
  ["source:list", () => database.listSources()],
  ["source:load-icon", () => undefined],
  ["entry:load-image", (_event, _id, _url, requestId) => {
    assert(typeof requestId === "string" && requestId.startsWith("image-"), "Image IPC must carry an opaque request id.");
    imageLoads++;
    if (!pauseImages) return fixtureImage;
    return new Promise((resolve) => { pendingImage = { requestId, resolve }; imageRequested?.(); });
  }],
  ["entry:cancel-image", (_event, requestId) => { cancelledImages.add(requestId); }],
  ["entry:list-page", (_event, query) => database.listEntryPage(query)],
  ["entry:counts", () => database.getLibraryCounts()],
  ["entry:read", (_event, id, read) => database.markRead(id, read)],
  ["entry:favorite", (_event, id, favorite) => database.markFavorite(id, favorite)],
  ["entry:dismiss", (_event, id) => database.dismissEntry(id)],
  ["entry:restore", (_event, id) => database.restoreEntry(id)],
  ["source:set-subscribed", (_event, id, subscribed) => database.setSubscribed(id, subscribed)],
  ["source:collection-settings", (_event, id) => database.getSourceCollectionSettings(id)],
  ["academic:search", () => Array.from({ length: 20 }, (_, index) => ({
    targetId: `openalex:A${index + 1}`,
    title: `Alexander Long-Name 同名作者 · OpenAlex A${index + 1} · ${index + 1} 篇`,
    config: { authorName: "Alexander Long-Name 同名作者", openAlexId: `A${index + 1}` }
  }))],
  ["entry:read-content", (_event, id) => {
    if (id === "failure") throw new Error("Deterministic offline fixture");
    return { kind: "article", article: { entryId: id, url: `https://example.com/${id}`, title: "Readable fixture", renderProfile: "standard", contentHtml: '<p>This is a deterministic reader fixture.</p><img src="https://fixture.invalid/body.gif" alt="Deterministic failed image">' } };
  }],
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
}, 45_000);

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
for (const [channel, handler] of channels) ipcMain.handle(channel, (event, ...args) => {
  try { return handler(event, ...args); } finally { database.publishChanges(); }
});

const messages = [];
const preloadErrors = [];
const window = new BrowserWindow({
  show: false,
  width: 1280, height: 800,
  webPreferences: {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
});
// Trigger a native, non-bubbling image failure without making an external request.
window.webContents.session.webRequest.onBeforeRequest({ urls: ["https://fixture.invalid/*"] }, (_details, callback) => callback({ cancel: true }));
window.webContents.on("console-message", (event) => messages.push(event.message));
window.webContents.on("preload-error", (_event, preloadPath, error) => {
  preloadErrors.push(`${preloadPath}: ${error.message}`);
});

const unsubscribe = database.onLibraryChanged((revision) => {
  if (!window.isDestroyed()) window.webContents.send("library:changed", revision);
});
async function evaluate(code) { return window.webContents.executeJavaScript(code); }
async function clickText(selector, text) {
  await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((element) => element.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
let failure;
try {
  await window.loadFile(renderer);
  await waitFor(window, "typeof window.reader === 'object' && typeof window.reader.listSources === 'function' && Boolean(document.querySelector('.shell'))");
  const result = await window.webContents.executeJavaScript("window.reader.listSources().then((sources) => ({ sources, shell: Boolean(document.querySelector('.shell')) }))");
  if (!result.shell || !Array.isArray(result.sources)) throw new Error("预加载桥接未能完成最小 IPC 往返。");
  if (preloadErrors.length) throw new Error(`沙箱预加载加载失败：${preloadErrors.join("；")}`);
  const preloadError = messages.find((message) => /Unable to load preload script|module not found/i.test(message));
  if (preloadError) throw new Error(`沙箱预加载加载失败：${preloadError}`);
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2");
  assert(await evaluate("document.querySelector('.timeline h1').textContent === '新收集'"), "The initial view must show collection order.");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Unavailable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-failure'))");
  assert(!database.getEntry("failure").read, "Failed reader load must leave content unread.");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && Boolean(document.querySelector('.entry-card.read'))");
  assert(database.getEntry("success").read, "Successful content must become read.");
  await waitFor(window, "document.querySelector('.article-body img')?.naturalWidth === 1");
  assert(imageLoads === 1, `A native body image error must invoke the proxy exactly once (observed ${imageLoads}).`);
  await clickText(".library-filter", "历史回填");
  await waitFor(window, "document.querySelector('.entry-card h2')?.textContent === 'Historical fixture'");
  pauseImages = true;
  const requested = new Promise((resolve) => { imageRequested = resolve; });
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Historical fixture\"]').click()");
  await waitFor(window, "document.querySelector('.article-body img')?.dataset.readerProxyTried === '1'");
  await requested;
  await evaluate("window.fixtureOldImage = document.querySelector('.article-body img')");
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  pauseImages = false;
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "document.querySelector('.article-body img')?.naturalWidth === 1");
  assert(cancelledImages.has(pendingImage.requestId), "Switching entries must cancel the old image IPC request.");
  pendingImage.resolve(fixtureImage);
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("!window.fixtureOldImage.isConnected && window.fixtureOldImage.src === 'https://fixture.invalid/body.gif'"), "Late image results must not change a detached article.");
  await evaluate("delete window.fixtureOldImage");
  await evaluate(`const input = document.querySelector('.entry-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Historical'); input.dispatchEvent(new Event('input', { bubbles: true }));`);
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 1 && document.querySelector('.entry-card h2').textContent === 'Historical fixture'");
  await clickText(".entry-actions button", "删除");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 0");
  await clickText(".library-filter", "最近删除");
  await waitFor(window, "document.querySelector('.entry-card h2')?.textContent === 'Historical fixture'");
  await clickText(".entry-actions button", "恢复内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 0");
  assert(database.getEntry("history"), "Deleted content must be recoverable through the UI.");
  await evaluate("document.querySelector('.source-filter').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
  await waitFor(window, "Boolean(document.querySelector('.source-settings-form'))");
  await clickText(".source-settings-operations button", "取消订阅");
  await waitFor(window, "Boolean(document.querySelector('.archived-sources')) && !document.querySelector('.source-settings-form')");
  assert(database.getSource(source.id).subscribed === false && database.getEntry("success").favorite, "Unsubscribe must retain favorites.");
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25]]) {
    window.setSize(width, height); window.webContents.setZoomFactor(scale);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const geometry = await evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth + 1, navBottom: document.querySelector('.library-nav').getBoundingClientRect().bottom, footerTop: document.querySelector('.sidebar-footer').getBoundingClientRect().top, sourcesHeight: document.querySelector('.source-list').clientHeight })`);
    assert(!geometry.overflow && geometry.navBottom < geometry.footerTop && geometry.sourcesHeight > 20, `Library navigation does not fit ${width}px at ${scale}.`);
    await writeFile(path.join(tmpdir(), `reading-hub-workflow-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  await clickText('[role="tab"]', "学术作者");
  await evaluate(`const query = document.querySelector('#academic-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(query, 'Alexander'); query.dispatchEvent(new Event('input', { bubbles: true }));`);
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await waitFor(window, "document.querySelectorAll('.academic-results button').length === 20");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    window.setSize(width, height); window.webContents.setZoomFactor(scale);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const fits = await evaluate(`(() => {
      const dialog = document.querySelector('.dialog');
      const bounds = dialog.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.academic-results button')];
      return bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1
        && dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.scrollHeight > dialog.clientHeight
        && buttons.every((button) => button.scrollWidth <= button.clientWidth + 1);
    })()`);
    assert(fits, `Academic identities or result scrolling do not fit ${width}px at ${scale}.`);
    await writeFile(path.join(tmpdir(), `reading-hub-academic-${width}.png`), (await window.capturePage()).toPNG());
  }
  console.log("Reading Hub renderer smoke test: passed; collection/search/read-failure/read-success/image-proxy/image-cancellation/late-image/unsubscribe/restore, library layouts and four academic search layouts verified.");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  clearTimeout(startupWatchdog);
  unsubscribe();
  database.close();
  for (const [channel] of channels) ipcMain.removeHandler(channel);
  if (!window.isDestroyed()) window.destroy();
}

// `app.quit()` waits for all macOS application lifecycle work to settle. That
// is useful for the product, but makes a hidden, single-purpose smoke process
// occasionally linger after its window has closed. The test has finished all
// asynchronous work at this point, so exit explicitly and deterministically.
app.exit(failure ? 1 : 0);
