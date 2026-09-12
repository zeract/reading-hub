import path from "node:path";
import { tmpdir } from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { ReadingDatabase } from "../dist/main/main/database.js";
import { verifyNavigationPolicy } from "./navigation-policy-smoke.mjs";

const root = path.resolve(import.meta.dirname, "..");
const preload = path.join(root, "dist", "main", "main", "preload.js");
const renderer = path.join(root, "dist", "renderer", "index.html");
const database = new ReadingDatabase(":memory:");
const source = database.createSource({ url: "https://example.com/feed", title: "Workflow fixture", kind: "rss", pollingEnabled: true });
for (const [id, title, ingestionKind] of [["success", "Readable fixture", "current"], ["failure", "Unavailable fixture", "current"], ["history", "Historical fixture", "history"]]) {
  database.saveEntries([{ id, sourceId: source.id, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`, title,
    ingestionKind, contentHash: id, createdAt: ingestionKind === "history" ? new Date(new Date().setDate(new Date().getDate() - 1)).getTime() : Date.now(), read: false, favorite: false }]);
}
database.markFavorite("success", true);
const fixtureImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
let pauseImages = false;
let imageLoads = 0;
let sourceIconReads = 0;
let pauseSourceIcons = true;
const pendingSourceIcons = [];
let sourceIconRequested;
const sourceIconStarted = new Promise((resolve) => { sourceIconRequested = resolve; });
let pendingImage;
let imageRequested;
const cancelledImages = new Set();
let pauseRead = false;
let pendingRead;
let readRequested;
let contentReadRequests = 0;
const cancelledReads = new Set();
let aiRequests = 0;
let aiMode = "complete";
let activeAiRequest;
let blockMarkdownModule = true;
let markdownModuleRequests = 0;
const cancelledAiRequests = new Set();
let providerLists = 0;
let settingsSaves = 0;
let pendingSettingsSave;
let settingsRequested;
let previewRequested;
const pendingPreviews = [];
let confirmationMode = "failure";
let confirmationRequests = 0;
let confirmationRequested;
let completeConfirmation;
let academicSubscriptionRequested;
let completeAcademicSubscription;
let academicSearchRequested;
let completeObsoleteSearch;
let managementRequested;
let completeManagement;
let managementWrites = 0;
let managementRefreshes = 0;
let managementFailure;
let managementCollection;
let managementScopeWrites = 0;
let managementFacetReads = 0;
let collectionReadFailure = false;
let delayedNavigationCommand;
let navigationCommandRequested;
let completeNavigationCommand;
let importRequested;
let completeImport;
let importRequests = 0;
let subscriptionWrites = 0;
let emptyLibrary = false;
let libraryPageFailure = false;
let completeFullscreenSnapshot;
let fullscreenSnapshotRequested;
const fullscreenSnapshotStarted = new Promise((resolve) => { fullscreenSnapshotRequested = resolve; });
let smallLibraryPages = false;
let nextLibraryPageFailure = false;
let pauseLibraryPage = false;
let completeLibraryPage;
let libraryPageRequested;
let restoreFailure = false;
let dismissFailure = false;
let pauseFavorite = false;
let favoriteRequested;
let completeFavorite;
let failFavorite;
let favoriteWrites = 0;
function deferNavigationCommand(operation) {
  return new Promise((resolve, reject) => {
    completeNavigationCommand = () => {
      try { const result = operation(); database.publishChanges(); resolve(result); }
      catch (error) { reject(error); }
    };
    navigationCommandRequested?.();
  });
}
let providerListFailure = false;
let modelListFailure = false;
const fixtureProviders = [
  { id: "openai", label: "Fixture AI", model: "fixture", configured: true, requiresApiKey: true },
  { id: "deepseek", label: "Fixture secondary AI", model: "fixture-secondary", configured: true, requiresApiKey: true }
];
const aiAnswer = "## Fixture answer\n\nInline $x^2$.\n\n$$\ny=x+1\n$$";
const channels = [
  ["source:import-opml", () => new Promise((resolve) => {
    importRequests++;
    completeImport = (result = { cancelled: true, imported: 0, existing: 0, skipped: 0 }) => resolve(result);
    importRequested?.();
  })],
  ...["source:update-settings", "source:update-rule"].map((channel) => [channel, () => new Promise((resolve) => {
    managementWrites++;
    completeManagement = () => resolve();
    managementRequested?.();
  })]),
  ["source:calibration", () => ({ title: "Calibration fixture", url: "https://example.com", candidates: [{ label: "Fixture cards", confidence: 0.9, rule: { version: 1, itemRootSelector: "article" }, preview: [] }] })],
  ["source:refresh", () => {
    managementRefreshes++;
    if (managementFailure === "calibration-refresh") throw new Error(`Synthetic calibration refresh failure ${"UnbrokenDiagnostic".repeat(35)}`);
    if (managementFailure === "refresh") throw new Error("Synthetic refresh failure");
    if (delayedNavigationCommand === "refresh") return deferNavigationCommand(() => undefined);
  }],
  ["academic:subscribe", () => new Promise((resolve) => {
    completeAcademicSubscription = () => resolve(source);
    academicSubscriptionRequested?.();
  })],
  ["source:confirm", () => {
    confirmationRequests++;
    if (confirmationMode === "failure") throw new Error("Synthetic confirmation failure");
    return new Promise((resolve) => { completeConfirmation = () => resolve(source); confirmationRequested?.(); });
  }],
  ["source:preview", (_event, url) => {
    const token = `fixture-preview-${pendingPreviews.length}`;
    return new Promise((resolve) => {
      pendingPreviews.push(() => resolve({ token, probe: { url, title: url, kind: "rss", confidence: 1, requiresReview: false, preview: [] } }));
      previewRequested?.();
    });
  }],
  ["ai:list-models", () => { if (modelListFailure) throw new Error("Synthetic catalog failure"); return { models: [{ id: "future-codex", label: "Future Codex", efforts: ["low", "ultra"], defaultEffort: "low" }], stale: false, updatedAt: Date.now() }; }],
  ["ai:list-providers", () => { providerLists++; if (providerListFailure) throw new Error(`Synthetic provider discovery failure ${"UnbrokenDiagnostic".repeat(35)}`); return fixtureProviders; }],
  ["ai:configure", (_event, configuration) => {
    settingsSaves++;
    assert(configuration.apiKey === "", "Settings fixture must use no credentials.");
    return new Promise((resolve) => {
      pendingSettingsSave = () => {
        fixtureProviders.find((provider) => provider.id === configuration.provider).model = configuration.model;
        resolve();
      };
      settingsRequested?.();
    });
  }],
  ["ai:ask-stream", (event, payload) => {
    aiRequests++;
    if (payload.request.selection?.intent === "translate") assert(!payload.request.article, "Selected-text translation must not send article context.");
    activeAiRequest = payload.requestId;
    event.sender.send("ai:stream", { requestId: payload.requestId, type: "delta", text: "Fixture" });
    if (aiMode === "pending") return;
    if (aiMode === "error") {
      event.sender.send("ai:stream", { requestId: payload.requestId, type: "delta", text: " partial answer" });
      event.sender.send("ai:stream", { requestId: payload.requestId, type: "error", message: "Fixture interruption" });
      return;
    }
    event.sender.send("ai:stream", { requestId: payload.requestId, type: "complete", answer: { provider: "openai", model: "fixture", text: aiAnswer } });
  }],
  ["ai:cancel-stream", (_event, requestId) => { cancelledAiRequests.add(requestId); }],
  ["library:revision", () => database.getLibraryRevision()],
  ["source:list", () => emptyLibrary ? [] : database.listSources()],
  ["source:load-icon", () => {
    sourceIconReads++;
    if (!pauseSourceIcons) return undefined;
    return new Promise((resolve) => { pendingSourceIcons.push(resolve); sourceIconRequested(); });
  }],
  ["entry:load-image", (_event, _id, _url, requestId) => {
    assert(typeof requestId === "string" && requestId.startsWith("image-"), "Image IPC must carry an opaque request id.");
    imageLoads++;
    if (!pauseImages) return fixtureImage;
    return new Promise((resolve) => { pendingImage = { requestId, resolve }; imageRequested?.(); });
  }],
  ["entry:cancel-image", (_event, requestId) => { cancelledImages.add(requestId); }],
  ["entry:list-page", (_event, query) => {
    if (libraryPageFailure) throw new Error("Synthetic library failure");
    if (query.cursor && nextLibraryPageFailure) throw new Error(`Synthetic next page failure ${"UnbrokenDiagnostic".repeat(32)}`);
    if (pauseLibraryPage) return new Promise((resolve) => { completeLibraryPage = () => resolve({ entries: [] }); libraryPageRequested?.(); });
    return emptyLibrary ? { entries: [] } : database.listEntryPage(smallLibraryPages ? { ...query, pageSize: 1 } : query);
  }],
  ["entry:counts", () => emptyLibrary ? { unread: 0, favorite: 0, today: 0 } : database.getLibraryCounts()],
  ["entry:read", (_event, id, read) => database.markRead(id, read)],
  ["entry:favorite", (_event, id, favorite) => {
    favoriteWrites++;
    if (pauseFavorite && id === "success") return new Promise((resolve, reject) => {
      completeFavorite = () => { database.markFavorite(id, favorite); database.publishChanges(); resolve(); };
      failFavorite = () => reject(new Error("Synthetic old favorite failure"));
      favoriteRequested?.();
    });
    return database.markFavorite(id, favorite);
  }],
  ["entry:dismiss", (_event, id) => {
    if (dismissFailure) throw new Error("Synthetic deletion failure");
    return delayedNavigationCommand === "dismiss"
      ? deferNavigationCommand(() => database.dismissEntry(id)) : database.dismissEntry(id);
  }],
  ["entry:restore", (_event, id) => {
    if (restoreFailure) throw new Error(typeof restoreFailure === "string" ? restoreFailure : "Synthetic restore failure");
    if (delayedNavigationCommand === "restore") return deferNavigationCommand(() => database.restoreEntry(id));
    return database.restoreEntry(id);
  }],
  ["source:delete", (_event, id) => {
    subscriptionWrites++;
    if (managementFailure === "subscription") throw new Error("Synthetic subscription failure");
    if (delayedNavigationCommand === "subscription") return deferNavigationCommand(() => database.deleteSource(id));
    return database.deleteSource(id);
  }],
  ["source:collection-settings", (_event, id) => { if (collectionReadFailure) throw new Error(`Synthetic collection read failure ${"UnbrokenDiagnostic".repeat(35)}`); return managementCollection ?? database.getSourceCollectionSettings(id); }],
  ["source:inspect-collection-facets", () => { managementFacetReads++; return []; }],
  ["source:update-collection-scope", (_event, _id, scope) => {
    managementScopeWrites++;
    managementCollection = { ...managementCollection, scope };
    return managementCollection;
  }],
  ["academic:search", (_event, query) => {
    if (query === "Unavailable Author") throw new Error(`Synthetic academic discovery failure ${"UnbrokenDiagnostic".repeat(35)}`);
    if (query === "Missing Author") return [];
    if (query === "Obsolete Author") return new Promise((resolve) => {
      completeObsoleteSearch = () => resolve([{ targetId: "openalex:OBSOLETE", title: "Obsolete author" }]);
      academicSearchRequested?.();
    });
    return Array.from({ length: 20 }, (_, index) => ({
    targetId: `openalex:A${index + 1}`,
    title: `Alexander Long-Name 同名作者 · OpenAlex A${index + 1} · ${index + 1} 篇`,
    config: { authorName: "Alexander Long-Name 同名作者", openAlexId: `A${index + 1}` }
    }));
  }],
  ["entry:cancel-read", (_event, requestId) => { cancelledReads.add(requestId); }],
  ["entry:read-content", (_event, id, requestId) => {
    contentReadRequests++;
    assert(typeof requestId === "string" && requestId.startsWith("read-"), "Read IPC must carry an opaque request id.");
    if (pauseRead) return new Promise((resolve) => { pendingRead = { requestId, resolve }; readRequested?.(); });
    if (id === "failure") throw new Error("Deterministic offline fixture");
    return { kind: "article", article: { entryId: id, url: `https://example.com/${id}`, title: "Readable fixture", renderProfile: "standard", activeLanguage: "zh", languageVariants: ["zh", "en"].map(language => ({ url: `https://example.com/${id}`, language, inlineLanguage: language, label: language === "zh" ? "中文" : "English" })), contentHtml: '<p>This is a deterministic reader fixture.</p><img src="https://fixture.invalid/body.gif" alt="Deterministic failed image" data-reader-zoomable="true" tabindex="0">' } };
  }],
  ["entry:read-language-variant", (_event, id, url, requestId, inlineLanguage) => {
    assert(url === `https://example.com/${id}` && ["zh", "en"].includes(inlineLanguage), "Inline IPC must carry its approved body separately from the URL.");
    assert(typeof requestId === "string", "Language switch must remain cancellable.");
    return { entryId: id, url, title: "Readable fixture", renderProfile: "standard", activeLanguage: inlineLanguage,
      languageVariants: ["zh", "en"].map(language => ({ url, language, inlineLanguage: language, label: language === "zh" ? "中文" : "English" })),
      contentHtml: `<p>This is a deterministic reader fixture.</p><p>Inline ${inlineLanguage} body.</p><img src="https://fixture.invalid/body.gif" alt="Deterministic failed image" data-reader-zoomable="true" tabindex="0">` };
  }],
  ["window:is-fullscreen", () => new Promise((resolve) => {
    completeFullscreenSnapshot = () => resolve(false);
    fullscreenSnapshotRequested();
  })]
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
      if (Date.now() >= deadline) return reject(new Error(`渲染器检查超时：${expression}`));
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
window.webContents.session.webRequest.onBeforeRequest({ urls: ["https://fixture.invalid/*", "file://*/*"] }, (details, callback) => {
  if (/\/ai-markdown-[^/]+\.js$/.test(new URL(details.url).pathname)) {
    markdownModuleRequests++;
    callback({ cancel: blockMarkdownModule });
  } else callback({ cancel: details.url.startsWith("https://fixture.invalid/") });
});
window.webContents.on("console-message", (event) => messages.push(event.message));
window.webContents.on("preload-error", (_event, preloadPath, error) => {
  preloadErrors.push(`${preloadPath}: ${error.message}`);
});

const unsubscribe = database.onLibraryChanged((revision) => {
  if (!window.isDestroyed()) window.webContents.send("library:changed", revision);
});
async function evaluate(code) { return window.webContents.executeJavaScript(code); }
async function setViewport(width, height, scale) {
  window.setSize(width, height);
  window.webContents.setZoomFactor(scale);
  const [contentWidth, contentHeight] = window.getContentSize();
  await waitFor(window, `Math.abs(innerWidth - ${contentWidth / scale}) <= 1 && Math.abs(innerHeight - ${contentHeight / scale}) <= 1`);
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}
async function pressKey(keyCode, modifiers = []) {
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  // Native controls such as summary activate on Enter's character event.
  if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}
async function clickText(selector, text) {
  await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((element) => element.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
let failure;
try {
  await verifyNavigationPolicy();
  await window.loadFile(renderer);
  await window.webContents.executeJavaScript(`document.fonts.ready.then(() => document.fonts.load('19px "Zhuque Fangsong"', "中文阅读")).then(fonts => { if (fonts.length !== 1 || fonts[0].status !== "loaded") throw new Error("Bundled Chinese font failed to load"); })`);
  await waitFor(window, "typeof window.reader === 'object' && typeof window.reader.listSources === 'function' && Boolean(document.querySelector('.shell'))");
  await fullscreenSnapshotStarted;
  window.webContents.send("window:fullscreen-changed", true);
  await waitFor(window, "document.querySelector('.shell')?.classList.contains('shell--fullscreen')");
  completeFullscreenSnapshot();
  await evaluate("window.reader.listSources().then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  assert(await evaluate("document.querySelector('.shell').classList.contains('shell--fullscreen')"), "A late startup snapshot must not overwrite a newer fullscreen event.");
  assert(await evaluate("getComputedStyle(document.querySelector('.shell')).getPropertyValue('--titlebar-leading-inset').trim() === '16px'"), "The fullscreen shell must reclaim the native window-button inset.");
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await waitFor(window, "document.querySelector('.settings-shell')?.classList.contains('settings-shell--fullscreen')");
  window.webContents.send("window:fullscreen-changed", false);
  await waitFor(window, "!document.querySelector('.settings-shell')?.classList.contains('settings-shell--fullscreen')");
  await evaluate("document.querySelector('[aria-label=\"返回阅读器\"]').click()");
  await waitFor(window, "!document.querySelector('.shell')?.classList.contains('shell--fullscreen')");
  assert(await evaluate("getComputedStyle(document.querySelector('.shell')).getPropertyValue('--titlebar-leading-inset').trim() === '96px'"), "Returning from settings must retain the latest windowed titlebar inset.");
  const result = await window.webContents.executeJavaScript("window.reader.listSources().then((sources) => ({ sources, shell: Boolean(document.querySelector('.shell')) }))");
  if (!result.shell || !Array.isArray(result.sources)) throw new Error("预加载桥接未能完成最小 IPC 往返。");
  if (preloadErrors.length) throw new Error(`沙箱预加载加载失败：${preloadErrors.join("；")}`);
  const preloadError = messages.find((message) => /Unable to load preload script|module not found/i.test(message));
  if (preloadError) throw new Error(`沙箱预加载加载失败：${preloadError}`);
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2");
  await sourceIconStarted;
  await evaluate("globalThis.failedSourceIcons = 0; document.addEventListener('error', event => { if (event.target instanceof HTMLImageElement && event.target.closest('.source-icon')) failedSourceIcons++; }, true)");
  const initialSourceIconReads = sourceIconReads;
  pauseSourceIcons = false;
  for (const resolve of pendingSourceIcons) resolve("data:image/png;base64,ZmFrZQ==");
  await waitFor(window, "failedSourceIcons === 1 && Boolean(document.querySelector('.source-icon-initial')?.textContent) && !document.querySelector('.source-icon--favicon')");
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(sourceIconReads === initialSourceIconReads, "A real favicon decode failure must restore the source initial without retrying IPC.");
  pauseLibraryPage = true;
  const oldRefreshStarted = new Promise((resolve) => { libraryPageRequested = resolve; });
  await evaluate("document.querySelector('[aria-label=\"重新载入收件箱\"]').click()");
  await oldRefreshStarted;
  pauseLibraryPage = false;
  pauseFavorite = true;
  const oldFavoriteStarted = new Promise((resolve) => { favoriteRequested = resolve; });
  await evaluate("[...document.querySelectorAll('.entry-card')].find(card => card.querySelector('h2').textContent === 'Readable fixture').querySelector('[aria-label=\"收藏\"]').click()");
  await oldFavoriteStarted;
  pauseFavorite = false;
  await evaluate("[...document.querySelectorAll('.entry-card')].find(card => card.querySelector('h2').textContent === 'Unavailable fixture').querySelector('.delete-entry').click()");
  await waitFor(window, "Boolean(document.querySelector('.notice-actions')) && document.querySelectorAll('.entry-card').length === 1");
  completeLibraryPage();
  failFavorite();
  await waitFor(window, "!document.querySelector('.entry-card [aria-label=\"收藏\"]').disabled");
  assert(database.getEntry("success").favorite, "A rejected favorite change must retain the previously confirmed state.");
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const undo = document.querySelector('.notice-actions button'); const notice = document.querySelector('.notice'); if (!undo || !notice?.textContent.includes('Unavailable fixture')) return false; const rect = undo.getBoundingClientRect(); const bounds = notice.getBoundingClientRect(); return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom; })()"), "An obsolete refresh or favorite failure must preserve the later deletion's visible undo at every viewport.");
    await writeFile(path.join(tmpdir(), `reading-hub-refresh-notice-${width}.png`), (await window.capturePage()).toPNG());
  }
  await clickText(".notice-actions button", "撤销删除");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2 && !document.querySelector('.notice-actions')");
  await evaluate("document.querySelector('[aria-label=\"关闭通知\"]').click()");
  assert(await evaluate("document.querySelector('.timeline h1').textContent === '今日'"), "The initial view must show the local Today union.");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Unavailable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-failure'))");
  assert(!database.getEntry("failure").read, "Failed reader load must leave content unread.");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && Boolean(document.querySelector('.entry-card.read'))");

  await waitFor(window, "document.querySelector('.article-body img')?.naturalWidth === 1");
  assert(imageLoads === 1, `A native body image error must invoke the proxy exactly once (observed ${imageLoads}).`);
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    for (const language of ["English", "中文"]) {
      await evaluate(`Array.from(document.querySelectorAll('.reader-language-switcher button')).find(button => button.textContent === ${JSON.stringify(language)}).click()`);
      await waitFor(window, `document.querySelector('.reader-language-switcher button[aria-pressed="true"]')?.textContent === ${JSON.stringify(language)}`);
      assert(await evaluate("document.querySelectorAll('.reader-language-switcher button[aria-pressed=true]').length === 1"), "A same-URL language switch must select one body.");
    }
  }

  assert(database.getEntry("success").read, "Successful content must become read.");
  await waitFor(window, "document.querySelector('.article-body img')?.naturalWidth === 1");
  assert(await evaluate("!document.querySelector('.reader-controls') && !document.querySelector('.reader-toolbar [aria-label=\"放大字号\"]')"), "Typography controls must only appear in settings.");
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.settings-font-controls'))");
  await evaluate("window.originalPreferenceSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'reading-hub.reader-preferences.v1') throw new DOMException('Synthetic storage failure', 'QuotaExceededError'); return window.originalPreferenceSetItem.call(this, key, value); }; document.querySelector('[aria-label=\"放大字号\"]').click()");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await evaluate("document.querySelector('[aria-label=\"返回阅读器\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article'))");
  await waitFor(window, "Boolean(document.querySelector('.reader-preference-status')) && document.querySelector('.reader-view').style.getPropertyValue('--reader-font-scale') === '1.05'");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const status = document.querySelector('.reader-preference-status'); const retry = status.querySelector('button'); const bounds = document.querySelector('.reader-view').getBoundingClientRect(); const rect = retry.getBoundingClientRect(); const tokens = getComputedStyle(document.documentElement); return status.scrollWidth <= status.clientWidth + 1 && rect.right <= bounds.right && rect.bottom <= document.querySelector('.reader-workspace').getBoundingClientRect().top && getComputedStyle(retry).fontSize === tokens.getPropertyValue('--control-font-size').trim(); })()"), "Preference retry must use shared controls and remain above the reader scroll area.");
    await writeFile(path.join(tmpdir(), `reading-hub-preferences-reader-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await waitFor(window, "document.querySelector('.settings-font-controls output')?.textContent === '105%' && Boolean(document.querySelector('.reader-preference-status'))");
  await clickText(".settings-segmented button", "紧凑");
  assert(await evaluate("[...document.querySelectorAll('.settings-segmented button')].find(button => button.textContent === '紧凑').getAttribute('aria-pressed') === 'true'"), "Settings density controls must expose the current shared preference.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const status = document.querySelector('.reader-preference-status'); const rect = status.querySelector('button').getBoundingClientRect(); const bounds = status.closest('.settings-card').getBoundingClientRect(); return status.scrollWidth <= status.clientWidth + 1 && rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom; })()"), "Settings must retain the same save-retry control within its card.");
    assert(await evaluate("(() => { const title = document.querySelector('.settings-titlebar p').getBoundingClientRect(); const button = document.querySelector('.settings-titlebar button').getBoundingClientRect(); return Math.abs((title.top + title.bottom - button.top - button.bottom) / 2) < 1; })()"), "Settings title and back button must share a vertical center at every viewport.");
    await writeFile(path.join(tmpdir(), `reading-hub-preferences-settings-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("Storage.prototype.setItem = window.originalPreferenceSetItem; document.querySelector('.reader-preference-status button').click()");
  await waitFor(window, "!document.querySelector('.reader-preference-status')");
  assert(await evaluate("(() => { const saved = JSON.parse(localStorage.getItem('reading-hub.reader-preferences.v1')); return saved.preset === 'compact' && saved.fontScale === 1.05; })()"), "Retry must save the latest shared preference, including changes made in settings.");
  await evaluate("document.querySelector('[aria-label=\"返回阅读器\"]').click()");
  await waitFor(window, "document.querySelector('.reader-view')?.dataset.readerPreset === 'compact' && document.querySelector('.article-body img')?.naturalWidth === 1");
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.settings-segmented'))");
  await clickText(".settings-segmented button", "阅读");
  await evaluate("document.querySelector('[aria-label=\"缩小字号\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"返回阅读器\"]').click()");
  await waitFor(window, "document.querySelector('.reader-view')?.style.getPropertyValue('--reader-font-scale') === '1' && document.querySelector('.article-body img')?.naturalWidth === 1");
  await writeFile(path.join(tmpdir(), "reading-hub-reader.png"), (await window.capturePage()).toPNG());
  await evaluate("document.querySelector('.article-body img').focus()");
  await pressKey("Enter");
  await waitFor(window, "Boolean(document.querySelector('.reader-image-lightbox'))");
  assert(await evaluate("document.activeElement.matches('.reader-image-lightbox__close')"), "Image preview must receive keyboard focus.");
  await pressKey("Tab");
  assert(await evaluate("document.querySelector('.reader-image-lightbox').contains(document.activeElement)"), "Tab must not leave the image modal.");
  await pressKey("Tab", ["shift"]);
  assert(await evaluate("document.querySelector('.reader-image-lightbox').contains(document.activeElement)"), "Shift+Tab must not leave the image modal.");
  await evaluate("document.querySelector('.reader-image-lightbox img').click()");
  assert(await evaluate("Boolean(document.querySelector('.reader-image-lightbox'))"), "Clicking the preview image must not dismiss it.");
  await pressKey("Escape");
  await waitFor(window, "!document.querySelector('.reader-image-lightbox')");
  assert(await evaluate("document.activeElement === document.querySelector('.article-body img')"), "Closing the image preview must restore image focus.");
  await pressKey("Enter");
  await waitFor(window, "Boolean(document.querySelector('.reader-image-lightbox'))");
  await evaluate("document.querySelector('.reader-image-lightbox').click()");
  await waitFor(window, "!document.querySelector('.reader-image-lightbox')");
  providerListFailure = true;
  await evaluate("document.querySelector('[aria-label=\"打开 AI 学习\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-ai-panel .ai-provider-feedback button'))");
  await evaluate("{ const input = document.querySelector('#ai-question'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Pending discovery draft'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.ai-question').requestSubmit(); }");
  assert(aiRequests === 0 && await evaluate("document.querySelector('#ai-provider').disabled && document.querySelector('.ai-question button').disabled"), "Failed discovery must preserve the draft without starting AI or treating the provider as unconfigured.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const error = document.querySelector('.reader-ai-panel .ai-provider-error'); const button = document.querySelector('.reader-ai-panel .ai-provider-feedback button'); button.scrollIntoView({ block: 'nearest' }); const rect = button.getBoundingClientRect(); const panel = button.closest('.reader-ai-panel').getBoundingClientRect(); return error.scrollWidth <= error.clientWidth + 1 && rect.right <= panel.right && rect.bottom <= panel.bottom && !button.disabled; })()"), "Reader discovery failures must wrap and keep retry reachable.");
    await writeFile(path.join(tmpdir(), `reading-hub-panel-discovery-${width}.png`), (await window.capturePage()).toPNG());
  }
  providerListFailure = false;
  await evaluate("document.querySelector('.reader-ai-panel .ai-provider-feedback button').focus()");
  await pressKey("Enter");
  await waitFor(window, "!document.querySelector('.reader-ai-panel .ai-provider-feedback') && document.querySelector('.reader-ai-panel option')?.textContent.includes('Fixture AI')");
  assert(aiRequests === 0 && await evaluate("document.querySelector('#ai-question').value === 'Pending discovery draft'"), "Read-only recovery must preserve the draft without submitting it.");
  const listsBeforePanelSelection = providerLists;
  await evaluate("{ const selector = document.querySelector('#ai-provider'); for (const id of ['deepseek', 'openai']) { selector.value = id; selector.dispatchEvent(new Event('change', { bubbles: true })); } }");
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(providerLists === listsBeforePanelSelection, "Changing a reader provider must not repeat discovery.");
  assert(markdownModuleRequests === 0, "The library, reader and empty assistant must not load AI Markdown code.");
  await evaluate("{ const question = document.querySelector('#ai-question'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, 'Explain fixture'); question.dispatchEvent(new Event('input', { bubbles: true })); }");
  await evaluate("document.querySelector('.ai-question').requestSubmit()");
  await waitFor(window, "document.querySelectorAll('.ai-markdown-load-error').length === 2 && !document.querySelector('#ai-question').disabled");
  assert(markdownModuleRequests === 1 && aiRequests === 1, "Messages must share a failed module load without repeating the question.");
  await evaluate("document.querySelector('.ai-markdown-load-error button').click()");
  await waitFor(window, "document.querySelectorAll('.ai-markdown-load-error').length === 2");
  assert(markdownModuleRequests === 2 && aiRequests === 1, "A failed retry must remain recoverable without replaying the question.");
  blockMarkdownModule = false;
  await evaluate("document.querySelector('.ai-markdown-load-error button').click()");
  await waitFor(window, "document.querySelectorAll('.ai-message.assistant .katex').length === 2 && !document.querySelector('#ai-question').disabled");
  assert(markdownModuleRequests === 3 && aiRequests === 1, "Retry must restore all messages with one module load and no AI replay.");
  assert(await evaluate("!document.querySelector('.ai-markdown-load-error') && document.querySelector('.ai-message.user').textContent.includes('Explain fixture')"), "Retry must preserve the original question and answer.");
  await evaluate("globalThis.fixtureAnswerFormula = document.querySelector('.ai-message.assistant .katex'); void 0");
  for (const draft of ["N", "Ne", "New question"]) {
    await evaluate(`{ const question = document.querySelector('#ai-question'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, ${JSON.stringify(draft)}); question.dispatchEvent(new Event('input', { bubbles: true })); }`);
  }
  await evaluate("document.querySelector('[aria-label=\"最小化 AI 学习助手\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"恢复 AI 学习助手\"]').click()");
  assert(await evaluate("document.querySelector('.ai-message.assistant .katex') === globalThis.fixtureAnswerFormula"), "Completed answer formula nodes must survive draft and panel updates.");
  assert(aiRequests === 1, "Editing a draft or minimizing the panel must not start a new AI request.");
  await evaluate("{ const selector = document.querySelector('#ai-provider'); selector.value = 'deepseek'; selector.dispatchEvent(new Event('change', { bubbles: true })); }");
  await waitFor(window, "document.querySelector('#ai-provider').value === 'deepseek'");
  assert(await evaluate("document.querySelector('.ai-message.assistant > strong').textContent === 'Fixture AI' && document.querySelector('.ai-message.assistant .katex') === globalThis.fixtureAnswerFormula"), "Changing provider must preserve the completed answer's author and formula DOM.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const button = document.querySelector('.ai-provider-row button'); const style = getComputedStyle(button); const send = getComputedStyle(document.querySelector('.ai-question button')); const rect = button.getBoundingClientRect(); const panel = button.closest('.reader-ai-panel').getBoundingClientRect(); return style.fontSize === send.fontSize && style.fontWeight === send.fontWeight && style.minHeight === send.minHeight && style.borderRadius === send.borderRadius && rect.right <= panel.right && rect.height >= 32; })()"), "AI settings must use the shared button style and remain inside the panel.");
    await writeFile(path.join(tmpdir(), `reading-hub-ai-attribution-${width}.png`), (await window.capturePage()).toPNG());
  }
  aiMode = "error";
  await evaluate("document.querySelector('.ai-question').requestSubmit()");
  await waitFor(window, "document.querySelector('.ai-message.assistant.error')?.textContent.includes('Fixture partial answer') && document.querySelector('.ai-message.assistant.error')?.textContent.includes('Fixture interruption') && !document.querySelector('#ai-question').disabled");
  await evaluate("{ const selector = document.querySelector('#ai-provider'); selector.value = 'openai'; selector.dispatchEvent(new Event('change', { bubbles: true })); }");
  await waitFor(window, "document.querySelector('#ai-provider').value === 'openai'");
  assert(await evaluate("JSON.stringify([...document.querySelectorAll('.ai-message.assistant > strong')].map((label) => label.textContent)) === JSON.stringify(['Fixture AI', 'Fixture secondary AI'])"), "Completed and interrupted answers must keep their respective provider labels after another switch.");
  aiMode = "pending";
  await evaluate("{ const question = document.querySelector('#ai-question'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, 'Pending fixture'); question.dispatchEvent(new Event('input', { bubbles: true })); }");
  await evaluate("{ const form = document.querySelector('.ai-question'); form.requestSubmit(); form.requestSubmit(); }");
  await waitFor(window, "document.querySelector('.ai-message.assistant.is-streaming')?.textContent.includes('Fixture')");
  await evaluate("document.querySelector('[aria-label=\"关闭 AI 学习助手\"]').click()");
  await waitFor(window, "!document.querySelector('.reader-ai-panel')");
  assert(aiRequests === 3 && cancelledAiRequests.has(activeAiRequest), "Closing the assistant must cancel its unfinished request over IPC.");
  window.webContents.send("ai:stream", { requestId: activeAiRequest, type: "delta", text: "Late fixture" });
  aiMode = "complete";
  providerListFailure = true;
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    await evaluate("(() => { const paragraph = document.querySelector('.article-body p'); paragraph.scrollIntoView({ block: 'center' }); const range = document.createRange(); range.selectNodeContents(paragraph); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()");
    await waitFor(window, "Boolean(document.querySelector('.reader-selection-toolbar'))");
    await clickText(".reader-selection-toolbar button", "提问");
    await evaluate("(() => { const input = document.querySelector('.reader-selection-toolbar input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '解释这段文字'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })); })()");
    assert(await evaluate("document.querySelector('.reader-selection-toolbar input')?.value === '解释这段文字'"), "Composing Escape must preserve the selected-text question draft.");
    if (width === 1720) {
      await evaluate("(() => { const input = document.querySelector('.entry-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Readable'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })); })()");
      await waitFor(window, "document.querySelectorAll('.entry-card').length === 1");
      assert(await evaluate("document.querySelector('.entry-search input').value === 'Readable' && Boolean(document.querySelector('.reader-selection-toolbar input'))"), "Composing Escape must leave both the search and selection workflow intact.");
      await pressKey("Escape");
      await waitFor(window, "document.querySelectorAll('.entry-card').length === 2");
      assert(await evaluate("document.querySelector('.entry-search input').value === '' && document.querySelector('.reader-selection-toolbar input')?.value === '解释这段文字'"), "Search must claim ordinary Escape without dismissing the selection question.");
    }
    await evaluate("document.querySelector('.reader-selection-toolbar input').focus()");
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert(await evaluate("(() => { const input = document.querySelector('.reader-selection-toolbar input'); const rect = input.getBoundingClientRect(); return input === document.activeElement && input.value === '解释这段文字' && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()"), "The preserved question and its focus must stay within the viewport.");
    await writeFile(path.join(tmpdir(), `reading-hub-selection-escape-${width}.png`), (await window.capturePage()).toPNG());
    await pressKey("Escape");
    await waitFor(window, "!document.querySelector('.reader-selection-toolbar')");
    await evaluate("(() => { const paragraph = document.querySelector('.article-body p'); const range = document.createRange(); range.selectNodeContents(paragraph); getSelection().removeAllRanges(); getSelection().addRange(range); paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()");
    await waitFor(window, "Boolean(document.querySelector('.reader-selection-toolbar'))");
    await clickText(".reader-selection-toolbar button", "翻译");
    await waitFor(window, "Boolean(document.querySelector('.selection-assistant-card .ai-provider-feedback button'))");
    assert(aiRequests === 3 && await evaluate("!document.querySelector('.selection-assistant-settings')"), "Selection discovery failure must offer a read retry without prompting credential changes or starting AI.");
    assert(await evaluate("(() => { const button = document.querySelector('.selection-assistant-card .ai-provider-feedback button'); button.scrollIntoView({ block: 'nearest' }); const rect = button.getBoundingClientRect(); const card = button.closest('.selection-assistant-card').getBoundingClientRect(); const error = document.querySelector('.selection-assistant-card .ai-provider-error'); return rect.bottom <= card.bottom && rect.right <= card.right && error.scrollWidth <= error.clientWidth + 1; })()"), "Selection retry must remain reachable inside the anchored card.");
    await writeFile(path.join(tmpdir(), `reading-hub-selection-discovery-${width}.png`), (await window.capturePage()).toPNG());
    if (width !== 1720) await evaluate("document.querySelector('[aria-label=\"关闭所选文字回答\"]').click()");
  }
  providerListFailure = false;
  await evaluate("document.querySelector('.selection-assistant-card .ai-provider-feedback button').click()");
  await waitFor(window, "document.querySelectorAll('.selection-assistant-answer .katex').length === 2");
  assert(aiRequests === 4, "Selection discovery recovery must start the original requested translation exactly once.");
  await evaluate("document.querySelector('[aria-label=\"关闭所选文字回答\"]').click()");
  pauseRead = true;
  const readStarted = new Promise((resolve) => { readRequested = resolve; });
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Unavailable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-loading'))");
  await readStarted;
  pauseRead = false;
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "document.querySelector('.article-body img')?.naturalWidth === 1");
  assert(cancelledReads.has(pendingRead.requestId), "Switching entries must cancel unfinished extraction over IPC.");
  pendingRead.resolve({ kind: "article", article: { entryId: "failure", url: "https://example.com/failure", title: "Stale extraction fixture", renderProfile: "standard", contentHtml: "<p>Stale extraction fixture</p>" } });
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("!document.querySelector('.reader-view').textContent.includes('Stale extraction fixture')"), "A cancelled extraction must not replace the current reader.");
  assert(!database.getEntry("failure").read, "Cancelled extraction must leave its entry unread.");
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
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
  await clickText(".notice-actions button", "撤销删除");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 1");
  assert(database.getEntry("history"), "Immediate undo must recover an accidental deletion without a trash view.");
  await evaluate("document.querySelector('.source-filter').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
  await waitFor(window, "Boolean(document.querySelector('.source-settings-form'))");
  const retainedFixtureEntries = database.listEntries();
  const previousSubscriptionWrites = subscriptionWrites;
  libraryPageFailure = true;
  await clickText(".source-settings-operations button", "取消订阅");
  await waitFor(window, "!document.querySelector('.source-settings-form') && document.querySelector('.notice')?.textContent.includes('Synthetic library failure')");
  assert(!database.getSource(source.id), "A list failure must not invalidate a committed unsubscription.");
  libraryPageFailure = false;
  await evaluate("document.querySelector('[aria-label=\"重新载入收件箱\"]').click()");
  await waitFor(window, "!document.querySelector('.source-filter') && !document.querySelector('.source-settings-form')");
  assert(subscriptionWrites === previousSubscriptionWrites + 1, "List recovery must not repeat a subscription write.");
  assert(!database.getSource(source.id) && !database.getEntry("success") && database.listEntries().length === 0, "Unsubscribe must delete exclusive articles including favorites.");
  assert(await evaluate("!document.querySelector('.archived-sources') && Boolean(document.querySelector('.empty-side'))"), "Unsubscribed records must not create an archived navigation section.");
  // Reset synthetic content for the independent navigation/settings scenarios.
  const replacementSource = database.createSource({ url: source.url, title: source.title, kind: source.kind, pollingEnabled: true });
  database.saveEntries(retainedFixtureEntries.map((entry) => ({ ...entry, sourceId: replacementSource.id, origins: undefined })));
  for (const entry of retainedFixtureEntries) {
    database.markFavorite(entry.id, entry.favorite);
    database.markRead(entry.id, entry.read);
  }
  database.publishChanges();
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  assert(await evaluate("document.querySelectorAll('.sidebar [aria-current=\"page\"]').length === 1 && document.querySelector('.library-filter[aria-current]')?.textContent === '全部内容'"), "Library navigation must expose only one current destination.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25]]) {
    await setViewport(width, height, scale);
    const geometry = await evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth + 1, navBottom: document.querySelector('.library-nav').getBoundingClientRect().bottom, footerTop: document.querySelector('.sidebar-footer').getBoundingClientRect().top, sourcesHeight: document.querySelector('.source-list').clientHeight })`);
    assert(!geometry.overflow && geometry.navBottom < geometry.footerTop && geometry.sourcesHeight > 20, `Library navigation does not fit ${width}px at ${scale}.`);
    await writeFile(path.join(tmpdir(), `reading-hub-workflow-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').focus(); document.querySelector('[aria-label=\"添加来源\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.dialog'))");
  assert(await evaluate("document.querySelector('.dialog').contains(document.activeElement)"), "Opening a source dialog must move keyboard focus inside it.");
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').focus()");
  assert(await evaluate("document.querySelector('.dialog').contains(document.activeElement)"), "A modal must prevent background controls from receiving focus.");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').focus()");
  await pressKey("Tab", ["shift"]);
  assert(await evaluate("document.querySelector('.dialog').contains(document.activeElement)"), "Reverse tab navigation must stay within the source dialog.");
  await pressKey("Tab");
  assert(await evaluate("document.querySelector('.dialog').contains(document.activeElement)"), "Forward tab navigation must stay within the source dialog.");
  await evaluate("document.querySelector('.modal-backdrop').click()");
  assert(await evaluate("Boolean(document.querySelector('.dialog'))"), "Source drafts must not close from backdrop clicks.");
  await evaluate("(() => { const input = document.querySelector('#source-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://example.com/keyboard-draft'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.dialog summary').focus(); })()");
  await pressKey("Enter");
  await waitFor(window, "document.querySelector('.dialog details').open");
  await pressKey("Tab");
  assert(await evaluate("document.activeElement === document.querySelector('[role=tab][aria-selected=true]')"), "Tab must enter the selected source method.");
  await pressKey("Left");
  assert(await evaluate("document.activeElement.textContent === '学术作者' && document.querySelector('#source-url').value === 'https://example.com/keyboard-draft' && !document.querySelector('#academic-query')"), "Arrow navigation must preserve the selected form and its draft until activation.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const tabs = [...document.querySelectorAll('[role=tab]')]; const focused = document.activeElement; const rect = focused.getBoundingClientRect(); const dialog = focused.closest('.dialog').getBoundingClientRect(); return tabs.filter((tab) => tab.tabIndex === 0).length === 1 && focused.getAttribute('aria-selected') === 'false' && getComputedStyle(focused).outlineStyle !== 'none' && rect.top >= dialog.top && rect.bottom <= dialog.bottom && tabs.every((tab) => { const panel = document.getElementById(tab.getAttribute('aria-controls')); return panel?.getAttribute('aria-labelledby') === tab.id && panel.hidden === (tab.getAttribute('aria-selected') !== 'true'); }) && document.querySelectorAll('[role=tabpanel]:not([hidden])').length === 1; })()"), "Source tabs must distinguish focus from selection and keep their panel relationships valid at every viewport.");
    await writeFile(path.join(tmpdir(), `reading-hub-source-tabs-${width}.png`), (await window.capturePage()).toPNG());
  }
  await pressKey("Tab");
  assert(await evaluate("document.activeElement === document.querySelector('[role=tabpanel]:not([hidden])')"), "Tab must leave the method list for the active panel, without activating the focused method.");
  await pressKey("Tab", ["shift"]);
  assert(await evaluate("document.activeElement === document.querySelector('[role=tab][aria-selected=true]')"), "Returning to the method list must restore the selected method's tab stop.");
  await pressKey("End"); await pressKey("Enter");
  await waitFor(window, "Boolean(document.querySelector('#academic-query'))");
  await pressKey("Home"); await pressKey("Space");
  await waitFor(window, "Boolean(document.querySelector('#source-url'))");
  assert(await evaluate("document.querySelector('.dialog details').open && document.activeElement === document.querySelector('[role=tab][aria-selected=true]')"), "Returning to the public method with Space must keep the selector and its focus visible.");
  await evaluate("document.querySelector('.dialog summary').focus()");
  await pressKey("Enter");
  await waitFor(window, "!document.querySelector('.dialog details').open");
  assert(await evaluate("Boolean(document.querySelector('#source-url'))"), "Collapsing the method selector must leave the active form available.");
  await pressKey("Escape");
  await waitFor(window, "!document.querySelector('.dialog')");
  assert(await evaluate("document.activeElement === document.querySelector('[aria-label=\"添加来源\"]')"), "Closing a modal must restore its opener's focus.");
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  const previewStarted = new Promise((resolve) => { previewRequested = resolve; });
  await evaluate(`(() => { const input = document.querySelector('#source-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://example.com/obsolete-feed'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await previewStarted;
  await pressKey("Escape");
  await waitFor(window, "!document.querySelector('.dialog')");
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  pendingPreviews[0]();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("document.querySelector('.dialog h2')?.textContent === '添加来源' && !document.querySelector('.preview-source-title')"), "A closed source form must not reopen confirmation over its replacement.");
  const currentPreviewStarted = new Promise((resolve) => { previewRequested = resolve; });
  await evaluate(`(() => { const input = document.querySelector('#source-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://example.com/current-feed'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate("document.querySelector('.connector-form').requestSubmit(); document.querySelector('.connector-form').requestSubmit()");
  await currentPreviewStarted;
  assert(pendingPreviews.length === 2, "Repeated form submission must not start another source probe.");
  pendingPreviews[1]();
  await waitFor(window, "document.querySelector('.preview-source-title')?.textContent === 'https://example.com/current-feed'");
  await clickText(".dialog-actions button", "保存来源");
  await waitFor(window, "document.querySelector('.dialog [role=\"alert\"]')?.textContent.includes('Synthetic confirmation failure') && !document.querySelector('.dialog-actions .primary').disabled");
  assert(await evaluate("document.querySelector('.dialog [role=\"alert\"]').textContent === 'Synthetic confirmation failure'"), "UI errors must omit the Electron transport wrapper.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate(`(() => { const dialog = document.querySelector('.dialog'); const error = dialog.querySelector('[role="alert"]').getBoundingClientRect(); const actions = dialog.querySelector('.dialog-actions').getBoundingClientRect(); return dialog.scrollWidth <= dialog.clientWidth + 1 && error.left >= 0 && error.right <= innerWidth + 1 && error.bottom <= actions.top && actions.bottom <= innerHeight; })()`), `Confirmation error and actions must fit ${width}px at ${scale}.`);
    await writeFile(path.join(tmpdir(), `reading-hub-confirmation-${width}.png`), (await window.capturePage()).toPNG());
  }
  confirmationMode = "pending";
  const confirmationStarted = new Promise((resolve) => { confirmationRequested = resolve; });
  await evaluate("document.querySelector('.dialog-actions .primary').click(); document.querySelector('.dialog-actions .primary').click()");
  await confirmationStarted;
  assert(confirmationRequests === 2, "Retry must start only one confirmation command.");
  await clickText(".dialog-actions button", "关闭");
  await waitFor(window, "!document.querySelector('.dialog')");
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  const replacementStarted = new Promise((resolve) => { previewRequested = resolve; });
  await evaluate(`(() => { const input = document.querySelector('#source-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://example.com/replacement-feed'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await replacementStarted;
  pendingPreviews[2]();
  await waitFor(window, "document.querySelector('.preview-source-title')?.textContent === 'https://example.com/replacement-feed'");
  completeConfirmation();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("document.querySelector('.preview-source-title')?.textContent === 'https://example.com/replacement-feed' && !document.querySelector('.dialog-actions .primary').disabled"), "A late successful confirmation must preserve the replacement preview and its controls.");
  await clickText(".dialog-actions button", "取消");
  await waitFor(window, "!document.querySelector('.dialog')");
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  await clickText('[role="tab"]', "学术作者");
  assert(await evaluate("!document.querySelector('.source-action-feedback')"), "Unsearched authors must not be described as missing.");
  for (const query of ["Unavailable Author", "Missing Author"]) {
    await evaluate(`(() => { const input = document.querySelector('#academic-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); })()`);
    await pressKey("Enter");
    await waitFor(window, query === "Unavailable Author" ? "Boolean(document.querySelector('.source-action-error'))" : "document.querySelector('.source-action-status')?.textContent.includes('未找到匹配的作者')");
    for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
      await setViewport(width, height, scale);
      await evaluate("document.querySelector('.source-action-feedback').scrollIntoView({ block: 'center' }); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert(await evaluate("(() => { const dialog = document.querySelector('.dialog'); const feedback = document.querySelector('.source-action-feedback'); const message = feedback.querySelector('p'); const rect = feedback.getBoundingClientRect(); const bounds = dialog.getBoundingClientRect(); return !document.querySelector('.academic-results') && !document.querySelector('.connector-search button').disabled && rect.top >= bounds.top && rect.bottom <= bounds.bottom && dialog.scrollWidth <= dialog.clientWidth + 1 && message.scrollWidth <= message.clientWidth + 1 && (!message.matches('[role=alert]') || message.clientHeight <= parseFloat(getComputedStyle(message).fontSize) * 9 + 1); })()"), "Author search error and empty results must remain distinct, bounded and readable.");
      await writeFile(path.join(tmpdir(), `reading-hub-source-feedback-${query === "Missing Author" ? "empty" : "error"}-${width}.png`), (await window.capturePage()).toPNG());
    }
  }
  const obsoleteSearchStarted = new Promise((resolve) => { academicSearchRequested = resolve; });
  await evaluate(`(() => { const input = document.querySelector('#academic-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Obsolete Author'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await obsoleteSearchStarted;
  assert(await evaluate("document.querySelector('.source-action-status')?.textContent === '正在搜索作者…'"), "An in-flight author search must announce loading.");
  await evaluate(`const query = document.querySelector('#academic-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(query, 'Alexander'); query.dispatchEvent(new Event('input', { bubbles: true }));`);
  assert(await evaluate("!document.querySelector('.connector-search button').disabled"), "Editing the author query must allow a replacement search immediately.");
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await waitFor(window, "document.querySelectorAll('.academic-results button').length === 20");
  completeObsoleteSearch();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("document.querySelectorAll('.academic-results button').length === 20 && !document.querySelector('.academic-results').textContent.includes('Obsolete author')"), "Late academic results must not replace the current matches.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
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
  const academicSubscriptionStarted = new Promise((resolve) => { academicSubscriptionRequested = resolve; });
  await evaluate("document.querySelector('.academic-results button').click()");
  await academicSubscriptionStarted;
  assert(await evaluate("document.querySelector('.source-action-status')?.textContent.includes('正在添加作者') && document.querySelector('.connector-search button').textContent === '搜索'"), "Subscription progress must not be described as another author search.");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  completeAcademicSubscription();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("Boolean(document.querySelector('#source-url'))"), "An older academic subscription must not close a replacement add-source dialog.");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  providerListFailure = true;
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await clickText(".settings-sidebar nav button", "AI 功能");
  await waitFor(window, "Boolean(document.querySelector('.ai-provider-error'))");
  assert(await evaluate("document.querySelector('.settings-actions .primary').disabled && document.querySelector('.settings-ai-form select').disabled && !document.querySelector('.settings-ai-form input')"), "Failed initial provider discovery must disable writes and omit unavailable configuration fields.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const error = document.querySelector('.ai-provider-error'); const button = document.querySelector('.ai-provider-feedback button'); button.scrollIntoView({ block: 'nearest' }); const rect = button.getBoundingClientRect(); const style = getComputedStyle(button); const tokens = getComputedStyle(document.documentElement); return document.documentElement.scrollWidth <= innerWidth + 1 && error.scrollWidth <= error.clientWidth + 1 && error.clientHeight <= parseFloat(getComputedStyle(error).fontSize) * 9 + 1 && rect.bottom <= innerHeight + 1 && style.minHeight === tokens.getPropertyValue('--control-height').trim() && style.borderRadius === tokens.getPropertyValue('--control-radius').trim(); })()"), "Provider read errors must wrap and scroll while keeping the shared retry button reachable.");
    await writeFile(path.join(tmpdir(), `reading-hub-provider-discovery-${width}.png`), (await window.capturePage()).toPNG());
  }
  providerListFailure = false;
  await evaluate("document.querySelector('.ai-provider-feedback button').focus()");
  await pressKey("Enter");
  await waitFor(window, "!document.querySelector('.ai-provider-feedback') && document.querySelectorAll('.settings-ai-form select option').length === 2");
  assert(settingsSaves === 0, "Retrying initial provider discovery must not write configuration.");
  const listsBeforeSelection = providerLists;
  await evaluate(`(() => { const provider = document.querySelector('.settings-ai-form select'); provider.value = 'deepseek'; provider.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evaluate(`(() => { const input = document.querySelector('.settings-ai-form input:not([type="password"])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'edited-fixture'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(providerLists === listsBeforeSelection, "Provider selection must not rediscover and overwrite the draft.");
  const saveRequested = new Promise((resolve) => { settingsRequested = resolve; });
  await evaluate(`(() => { const form = document.querySelector('.settings-ai-form'); form.requestSubmit(); form.requestSubmit(); })()`);
  await saveRequested;
  assert(settingsSaves === 1, "Repeated native form submission must issue only one settings command.");
  providerListFailure = true;
  pendingSettingsSave();
  await waitFor(window, "document.querySelector('.ai-provider-feedback')?.textContent.includes('设置操作已完成')");
  assert(await evaluate("document.querySelector('.settings-actions .primary').disabled && document.querySelector('.settings-actions .danger').disabled"), "A committed settings update must not be repeated to recover a failed read.");
  assert(fixtureProviders.find((provider) => provider.id === "deepseek").model === "edited-fixture", "The settings write must remain committed during failed discovery.");
  providerListFailure = false;
  await evaluate("document.querySelector('.ai-provider-feedback button').click()");
  await waitFor(window, "!document.querySelector('.settings-actions .primary').disabled && document.querySelector('.settings-ai-form input').value === 'edited-fixture'");
  assert(settingsSaves === 1, "Discovery retry must recover the saved provider without another write.");
  assert(await evaluate("document.querySelector('.settings-ai-form select').value === 'deepseek'"), "Save refresh must preserve the selected provider.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.settings-content').scrollWidth <= document.querySelector('.settings-content').clientWidth + 1"), `Settings overflow at ${width}px and ${scale}.`);
    await writeFile(path.join(tmpdir(), `reading-hub-settings-${width}.png`), (await window.capturePage()).toPNG());
  }
  const lastSaveRequested = new Promise((resolve) => { settingsRequested = resolve; });
  await evaluate("document.querySelector('.settings-ai-form').requestSubmit()");
  await lastSaveRequested;
  await evaluate("document.querySelector('[aria-label=\"返回阅读器\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.shell'))");
  const listsBeforeCloseCompletion = providerLists;
  pendingSettingsSave();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(providerLists === listsBeforeCloseCompletion, "A closed settings view must not start another provider query.");
  fixtureProviders.push({ id: "codex-cli", label: "Local fixture", model: "saved-codex", effort: "high", configured: true, requiresApiKey: false });
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await clickText(".settings-sidebar nav button", "AI 功能");
  await waitFor(window, "[...document.querySelectorAll('.settings-ai-form option')].some(option => option.value === 'future-codex')");
  assert(await evaluate("document.querySelectorAll('.settings-ai-form select')[1].value === 'saved-codex'"), "Catalog discovery must preserve the saved model.");
  await evaluate("(() => { const model = document.querySelectorAll('.settings-ai-form select')[1]; model.value = 'future-codex'; model.dispatchEvent(new Event('change', { bubbles: true })); })()");
  assert(await evaluate("[...document.querySelectorAll('.settings-ai-form select')[2].options].map(option => option.value).join(',') === 'default,low,ultra'"), "Codex reasoning options must come from the selected model.");
  modelListFailure = true;
  await clickText(".settings-actions button", "刷新模型");
  await waitFor(window, "document.querySelector('.settings-ai-form [role=status]')?.textContent.includes('已有选择保持不变')");
  assert(await evaluate("document.querySelectorAll('.settings-ai-form select')[1].value === 'future-codex'"), "Failed catalog refresh must preserve the draft.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.settings-content').scrollWidth <= document.querySelector('.settings-content').clientWidth + 1"), `Dynamic model settings overflow at ${width}px.`);
  }
  await evaluate("document.querySelector('[aria-label=\"返回阅读器\"]').click()");
  fixtureProviders.pop(); modelListFailure = false;
  database.createSource({ url: "https://example.com/management", title: "Management fixture", kind: "generic", pollingEnabled: true });
  database.publishChanges();
  const openManagement = async () => {
    await waitFor(window, "[...document.querySelectorAll('.source-filter')].some((item) => item.textContent.includes('Management fixture'))");
    await evaluate("[...document.querySelectorAll('.source-filter')].find((item) => item.textContent.includes('Management fixture')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
    await waitFor(window, "Boolean(document.querySelector('.source-settings-form'))");
  };
  collectionReadFailure = true;
  await openManagement();
  await waitFor(window, "Boolean(document.querySelector('.source-collection-load [role=alert]'))");
  await evaluate("{ const input = document.querySelector('.source-settings-body > label input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Collection recovery draft'); input.dispatchEvent(new Event('input', { bubbles: true })); }");
  const writesBeforeCollectionRecovery = managementWrites;
  const scopeWritesBeforeCollectionRecovery = managementScopeWrites;
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    await evaluate("document.querySelector('.source-collection-load').scrollIntoView({ block: 'center' }); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert(await evaluate("(() => { const feedback = document.querySelector('.source-collection-load'); const button = feedback.querySelector('button'); const error = feedback.querySelector('[role=alert]'); const rect = button.getBoundingClientRect(); const body = button.closest('.source-settings-body').getBoundingClientRect(); const style = getComputedStyle(button); const save = getComputedStyle(document.querySelector('.dialog-actions .primary')); return error.scrollWidth <= error.clientWidth + 1 && error.clientHeight <= parseFloat(getComputedStyle(error).fontSize) * 9 + 1 && rect.top >= body.top && rect.bottom <= body.bottom && style.minHeight === save.minHeight && style.borderRadius === save.borderRadius && !button.disabled; })()"), "Collection read errors must scroll and keep the shared retry action reachable.");
    await writeFile(path.join(tmpdir(), `reading-hub-collection-read-${width}.png`), (await window.capturePage()).toPNG());
  }
  collectionReadFailure = false;
  await evaluate("document.querySelector('.source-collection-load button').focus()");
  await pressKey("Enter");
  await waitFor(window, "!document.querySelector('.source-collection-load')");
  assert(managementWrites === writesBeforeCollectionRecovery && managementScopeWrites === scopeWritesBeforeCollectionRecovery && await evaluate("document.querySelector('.source-settings-body > label input').value === 'Collection recovery draft'"), "Collection recovery must preserve the metadata draft without any write.");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  for (const mode of ["settings", "calibration"]) {
    await openManagement();
    if (mode === "calibration") {
      await clickText(".source-settings-operations button", "自动校准");
      await waitFor(window, "Boolean(document.querySelector('.calibration-candidate button'))");
    }
    for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
      await setViewport(width, height, scale);
      assert(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.dialog').scrollWidth <= document.querySelector('.dialog').clientWidth + 1"), `${mode} dialog overflow at ${width}px and ${scale}.`);
      if (mode === "settings") {
        assert(await evaluate(`(() => {
          const body = document.querySelector('.source-settings-body');
          const footer = document.querySelector('.source-settings-form .dialog-actions');
          const fits = () => body.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top + 1 && footer.getBoundingClientRect().bottom <= innerHeight;
          const top = footer.getBoundingClientRect().top;
          body.scrollTop = body.scrollHeight;
          const valid = fits() && footer.getBoundingClientRect().top === top;
          body.scrollTop = 0;
          return valid;
        })()`), `Settings save actions must remain visible while the form scrolls at ${width}px and ${scale}.`);
      }
      await writeFile(path.join(tmpdir(), `reading-hub-management-${mode}-${width}.png`), (await window.capturePage()).toPNG());
    }
    const requested = new Promise((resolve) => { managementRequested = resolve; });
    const before = managementWrites;
    await evaluate(mode === "settings"
      ? "(() => { const form = document.querySelector('.source-settings-form'); form.requestSubmit(); form.requestSubmit(); })()"
      : "(() => { const button = document.querySelector('.calibration-candidate button'); button.click(); button.click(); })()");
    await requested;
    assert(managementWrites === before + 1, `Repeated ${mode} submission must start one write.`);
    await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
    await openManagement();
    if (mode === "calibration") {
      await clickText(".source-settings-operations button", "自动校准");
      await waitFor(window, "Boolean(document.querySelector('.calibration-candidate button'))");
    } else {
      await evaluate("(() => { const input = document.querySelector('.source-settings-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Replacement draft'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    }
    completeManagement();
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert(await evaluate(mode === "settings" ? "Boolean(document.querySelector('.source-settings-form'))" : "Boolean(document.querySelector('.calibration-candidate'))"), `An older ${mode} write must not close a replacement session for the same source.`);
    if (mode === "settings") assert(await evaluate("document.querySelector('.source-settings-form input').value === 'Replacement draft'"), "A reload from the old save must preserve the replacement draft.");
    await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  }
  await openManagement();
  await clickText(".source-settings-operations button", "自动校准");
  await waitFor(window, "Boolean(document.querySelector('.calibration-candidate button'))");
  managementFailure = "calibration-refresh";
  const calibrationRequested = new Promise((resolve) => { managementRequested = resolve; });
  const beforeCalibrationWrites = managementWrites;
  const beforeCalibrationRefreshes = managementRefreshes;
  await clickText(".calibration-candidate button", "这组内容是正确的");
  await calibrationRequested;
  completeManagement();
  await waitFor(window, "Boolean(document.querySelector('.calibration-error'))");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    await evaluate("document.querySelector('.dialog-actions .primary').scrollIntoView({ block: 'center' }); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert(await evaluate("(() => { const error = document.querySelector('.calibration-error'); const retry = document.querySelector('.dialog-actions .primary'); const rect = retry.getBoundingClientRect(); const dialog = retry.closest('.dialog').getBoundingClientRect(); return document.querySelector('.calibration-status').getBoundingClientRect().top >= document.querySelector('.calibration-candidate').getBoundingClientRect().bottom + 8 && document.querySelector('.calibration-candidate button').disabled && document.querySelector('.dialog-actions button:nth-child(2)').disabled && document.querySelector('.dialog [role=status]').textContent.includes('规则已保存，来源刷新尚未完成') && error.scrollWidth <= error.clientWidth + 1 && error.clientHeight <= parseFloat(getComputedStyle(error).fontSize) * 9 + 1 && rect.top >= dialog.top && rect.bottom <= dialog.bottom && rect.right <= dialog.right && !retry.disabled; })()"), "Calibration recovery must keep committed candidates locked and its bounded error and retry reachable.");
    await writeFile(path.join(tmpdir(), `reading-hub-calibration-recovery-${width}.png`), (await window.capturePage()).toPNG());
  }
  managementFailure = undefined;
  await evaluate("document.querySelector('.dialog-actions .primary').focus()");
  await pressKey("Enter");
  await waitFor(window, "!document.querySelector('.dialog')");
  assert(managementWrites === beforeCalibrationWrites + 1 && managementRefreshes === beforeCalibrationRefreshes + 2, "Calibration recovery must retry only the failed refresh, without another rule reset.");
  await openManagement();
  for (const [operation, label] of [["refresh", "立即刷新"], ["subscription", "取消订阅"]]) {
    managementFailure = operation;
    await clickText(".source-settings-operations button", label);
    await waitFor(window, `document.querySelector('.source-settings-form > .error')?.textContent === 'Synthetic ${operation} failure'`);
    assert(await evaluate("!document.querySelector('.source-settings-form .primary').disabled"), "A failed management operation must leave the current form available for retry.");
    if (operation === "refresh") for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
      await setViewport(width, height, scale);
      assert(await evaluate(`(() => {
        const error = document.querySelector('.source-settings-form > [role=alert]').getBoundingClientRect();
        const footer = document.querySelector('.source-settings-form .dialog-actions').getBoundingClientRect();
        return error.top >= 0 && error.bottom <= footer.top && footer.bottom <= innerHeight;
      })()`), `Management errors and retry actions must remain visible at ${width}px and ${scale}.`);
      await writeFile(path.join(tmpdir(), `reading-hub-management-error-${width}.png`), (await window.capturePage()).toPNG());
    }
  }
  managementFailure = undefined;
  libraryPageFailure = true;
  await clickText(".source-settings-operations button", "立即刷新");
  await waitFor(window, "!document.querySelector('.source-settings-form > .error') && !document.querySelector('.source-settings-form .primary').disabled");
  assert(await evaluate("document.querySelector('.notice')?.textContent.includes('Synthetic library failure')"), "A successful source refresh must leave list failure with the read model, not the dialog action.");
  libraryPageFailure = false;
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  await evaluate("window.fixtureUnhandled = 0; window.fixtureRejectionListener = () => { window.fixtureUnhandled++; }; window.addEventListener('unhandledrejection', window.fixtureRejectionListener); [...document.querySelectorAll('.source-filter')].find((item) => item.textContent.includes('Management fixture')).click()");
  await waitFor(window, "Boolean(document.querySelector('[aria-label=\"刷新 Management fixture\"]'))");
  managementFailure = "refresh";
  await evaluate("document.querySelector('[aria-label=\"刷新 Management fixture\"]').click()");
  await waitFor(window, "document.querySelector('.notice')?.textContent.includes('Synthetic refresh failure') && !document.querySelector('[aria-label=\"刷新 Management fixture\"]').disabled");
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("window.fixtureUnhandled === 0"), "Toolbar refresh errors must be handled after publishing the notice.");
  await evaluate("window.removeEventListener('unhandledrejection', window.fixtureRejectionListener); delete window.fixtureRejectionListener; delete window.fixtureUnhandled");
  managementCollection = { scope: { facetSelections: [], history: { mode: "none" } }, facets: [{ scheme: "fixture", key: "science", label: "Science", entryCount: 1 }] };
  await openManagement();
  await evaluate("document.querySelector('.facet-option input').click()");
  const scopeSaveRequested = new Promise((resolve) => { managementRequested = resolve; });
  await evaluate("document.querySelector('.source-settings-form').requestSubmit()");
  await scopeSaveRequested;
  completeManagement();
  await waitFor(window, "document.querySelector('.source-settings-form > [role=status]')?.textContent.includes('收集范围已保存，刷新尚未完成')");
  assert(managementScopeWrites === 1, "The selected scope must be saved once before refresh fails.");
  await setViewport(1440, 900, 1.25);
  assert(await evaluate(`(() => {
    const status = document.querySelector('.source-settings-form > [role=status]').getBoundingClientRect();
    const footer = document.querySelector('.source-settings-form .dialog-actions').getBoundingClientRect();
    return status.top >= 0 && status.bottom <= footer.top && footer.bottom <= innerHeight;
  })()`), "Partial-save status and retry action must fit at 125% font size.");
  await writeFile(path.join(tmpdir(), "reading-hub-management-partial-save.png"), (await window.capturePage()).toPNG());
  managementFailure = undefined;
  libraryPageFailure = true;
  const beforeScopeRecoveryRefreshes = managementRefreshes;
  const scopeRetryRequested = new Promise((resolve) => { managementRequested = resolve; });
  await evaluate("document.querySelector('.source-settings-form').requestSubmit()");
  await scopeRetryRequested;
  completeManagement();
  await waitFor(window, "!document.querySelector('.source-settings-form')");
  assert(managementScopeWrites === 1, "Retrying the failed refresh must not repeat the saved scope write.");
  assert(await evaluate("document.querySelector('.notice')?.textContent.includes('Synthetic library failure')"), "A completed scope refresh must close the dialog while preserving list recovery.");
  libraryPageFailure = false;
  await evaluate("[...document.querySelectorAll('.source-filter')].find((item) => item.textContent.includes('Management fixture')).click()");
  await waitFor(window, "!document.querySelector('.notice')?.textContent.includes('Synthetic library failure')");
  assert(managementRefreshes === beforeScopeRecoveryRefreshes + 1, "Reloading the source view must not repeat its successful scope refresh.");
  const retainedFacetLabel = `Saved category ${"LongLabel".repeat(20)}`;
  managementCollection = { scope: { facetSelections: [{ scheme: "fixture", key: "retained", label: retainedFacetLabel }], history: { mode: "none" } }, facets: [], facetDiscoveryAvailable: true, historyAvailable: false };
  await openManagement();
  await waitFor(window, "document.querySelector('.facet-option input')?.checked && Boolean(document.querySelector('.source-collection-scope__heading button'))");
  assert(await evaluate("!document.querySelector('.history-options') && document.querySelector('.source-collection-scope').textContent.includes('仍会参与筛选')"), "Missing saved categories must remain actionable independently of history capability.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    await evaluate("document.querySelector('.source-collection-scope').scrollIntoView({ block: 'center' }); new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await waitFor(window, "(() => { const option = document.querySelector('.facet-option').getBoundingClientRect(); const body = document.querySelector('.source-settings-body').getBoundingClientRect(); return option.top >= body.top && option.bottom <= body.bottom; })()");
    assert(await evaluate("(() => { const button = document.querySelector('.source-collection-scope__heading button'); const style = getComputedStyle(button); const save = getComputedStyle(document.querySelector('.dialog-actions .primary')); const label = document.querySelector('.facet-option span'); const field = button.closest('fieldset'); return style.fontSize === save.fontSize && style.minHeight === save.minHeight && style.borderRadius === save.borderRadius && field.scrollWidth <= field.clientWidth + 1 && label.title === label.textContent && label.scrollWidth > label.clientWidth && button.getBoundingClientRect().right <= field.getBoundingClientRect().right; })()"), "Retained category labels and shared discovery buttons must fit the collection editor.");
    await writeFile(path.join(tmpdir(), `reading-hub-retained-category-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("document.querySelector('.source-collection-scope__heading button').focus()");
  await pressKey("Enter");
  await waitFor(window, "!document.querySelector('.source-collection-scope__heading button').disabled");
  assert(managementFacetReads === 1 && await evaluate("document.querySelector('.facet-option input').checked"), "An empty discovery result must preserve the saved filter without writing it.");
  await evaluate("document.querySelector('.facet-option input').click()");
  assert(await evaluate("Boolean(document.querySelector('.facet-option input')) && !document.querySelector('.facet-option input').checked"), "An unchecked retained category must remain available until save.");
  await evaluate("document.querySelector('.facet-option input').click()");
  await evaluate("document.querySelector('.facet-option input').click()");
  const retainedRemovalRequested = new Promise((resolve) => { managementRequested = resolve; });
  const writesBeforeRetainedRemoval = managementScopeWrites;
  await evaluate("document.querySelector('.source-settings-form').requestSubmit()");
  await retainedRemovalRequested;
  completeManagement();
  await waitFor(window, "!document.querySelector('.source-settings-form')");
  assert(managementScopeWrites === writesBeforeRetainedRemoval + 1 && managementCollection.scope.facetSelections.length === 0 && managementCollection.scope.history.mode === "none", "Saving must remove the retained filter through the existing scope write contract.");
  for (const operation of ["refresh", "subscription"]) {
    await evaluate("[...document.querySelectorAll('.source-filter')].find((item) => item.textContent.includes('Management fixture')).click()");
    await waitFor(window, "document.querySelector('.timeline h1')?.textContent === 'Management fixture'");
    delayedNavigationCommand = operation;
    const started = new Promise((resolve) => { navigationCommandRequested = resolve; });
    if (operation === "refresh") await evaluate("document.querySelector('[aria-label=\"刷新 Management fixture\"]').click()");
    else {
      await openManagement();
      await clickText(".source-settings-operations button", "取消订阅");
    }
    await started;
    if (operation === "subscription") await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
    await evaluate("[...document.querySelectorAll('.library-filter')].find((item) => item.querySelector('span')?.textContent === '收藏').click()");
    await waitFor(window, "document.querySelectorAll('.entry-card').length === 1");
    delayedNavigationCommand = undefined;
    completeNavigationCommand();
    await waitFor(window, "!document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
    assert(await evaluate("document.querySelector('.timeline h1')?.textContent === '收藏文章' && document.querySelectorAll('.entry-card').length === 1 && document.querySelector('.entry-card h2')?.textContent === 'Readable fixture'"), `A late ${operation} must refresh the current favorites view without restoring its old source selection.`);
  }
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article'))");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const tokens = getComputedStyle(document.documentElement); return [...document.querySelectorAll('.entry-actions button')].every(button => { const style = getComputedStyle(button); const rect = button.getBoundingClientRect(); const card = button.closest('.entry-card').getBoundingClientRect(); return style.fontSize === tokens.getPropertyValue('--control-font-size').trim() && style.fontWeight === '600' && style.minHeight === tokens.getPropertyValue('--control-height').trim() && style.borderRadius === tokens.getPropertyValue('--control-radius').trim() && rect.width >= 32 && rect.left >= card.left && rect.right <= card.right && rect.bottom <= card.bottom; }); })()"), "Card actions must share control typography and remain usable within each card.");
    await writeFile(path.join(tmpdir(), `reading-hub-card-actions-${width}.png`), (await window.capturePage()).toPNG());
  }
  pauseFavorite = true;
  const favoriteStarted = new Promise((resolve) => { favoriteRequested = resolve; });
  const previousFavoriteWrites = favoriteWrites;
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await favoriteStarted;
  assert(await evaluate("document.querySelector('.entry-card.selected [aria-label=\"收藏\"]').disabled"), "Saving a reader favorite must also disable the same list action.");
  await evaluate("document.querySelector('.entry-card.selected [aria-label=\"收藏\"]').click()");
  assert(favoriteWrites === previousFavoriteWrites + 1, "The same pending favorite must not be written twice.");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Historical fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && document.querySelector('.entry-card.selected h2')?.textContent === 'Historical fixture'");
  assert(await evaluate("!document.querySelector('.reader-view .favorite-button').disabled"), "A pending favorite must not block a different article.");
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.reader-view .favorite-button').disabled");
  pauseFavorite = false;
  completeFavorite();
  await waitFor(window, "[...document.querySelectorAll('.entry-card')].find(card => card.querySelector('h2')?.textContent === 'Readable fixture')?.querySelector('[aria-label=\"收藏\"]')?.textContent === '☆'");
  assert(await evaluate("document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'true'"), "An old favorite completion must not change the current article.");
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('.reader-view .favorite-button').disabled");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && !document.querySelector('.reader-view .favorite-button').disabled");
  await evaluate("document.querySelector('.entry-card.selected [aria-label=\"收藏\"]').click()");
  await waitFor(window, "document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.reader-view .favorite-button').disabled");
  // Background metadata changes must reach the reader without reloading content.
  const readsBeforeBackgroundChange = contentReadRequests;
  await evaluate("globalThis.workflowArticleBeforeRefresh = document.querySelector('.article-body')");
  database.markFavorite("success", false);
  database.markRead("success", false);
  database.publishChanges();
  await waitFor(window, "document.querySelector('.entry-card.selected [aria-label=\"收藏\"]')?.textContent === '☆' && !document.querySelector('.entry-card.selected')?.classList.contains('read')");
  assert(await evaluate("document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'false'"), "A background list refresh must update the selected reader's favorite state.");
  assert(contentReadRequests === readsBeforeBackgroundChange, "Refreshing entry metadata must not reload the article body.");
  assert(await evaluate("document.querySelector('.article-body') === globalThis.workflowArticleBeforeRefresh"), "Refreshing entry metadata must preserve the mounted article DOM.");
  await evaluate("delete globalThis.workflowArticleBeforeRefresh");
  assert(!database.getEntry("success").read, "Refreshing metadata must not automatically mark the open article read again.");
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.reader-view .favorite-button').disabled");
  assert(database.getEntry("success").favorite, "The reader toggle must use the refreshed favorite value.");
  for (const [query, count] of [["Historical", 1], ["NoMatchingReaderSelection", 0]]) {
    await evaluate(`(() => { const input = document.querySelector('.entry-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(window, `document.querySelectorAll('.entry-card').length === ${count}`);
    assert(await evaluate("Boolean(document.querySelector('.reader-article')) && document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'true'"), "Filtering the selected article out of the list must retain the current reader.");
  }
  await evaluate("document.querySelector('.entry-search-clear').click()");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  assert(contentReadRequests === readsBeforeBackgroundChange, "Filtering and restoring the list must not fetch the selected article again.");
  // A committed flag must remain usable even if the following list read fails.
  libraryPageFailure = true;
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelector('.notice')?.textContent.includes('Synthetic library failure') && !document.querySelector('.reader-view .favorite-button').disabled");
  assert(!database.getEntry("success").favorite, "The favorite write must have committed before the read failure.");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Historical fixture\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && document.querySelector('.entry-card.selected h2')?.textContent === 'Readable fixture'");
  assert(await evaluate("document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'false' && document.querySelector('.entry-card.selected [aria-label=\"收藏\"]')?.textContent === '☆'"), "Reopening a card after a list read failure must preserve the committed favorite in both views.");
  libraryPageFailure = false;
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelector('.reader-view .favorite-button')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.reader-view .favorite-button').disabled");
  assert(database.getEntry("success").favorite, "The next toggle must use the committed value, not the stale list snapshot.");
  await evaluate("[...document.querySelectorAll('.library-filter')].find(item => item.querySelector('span')?.textContent === '收藏').click()");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 1");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && document.querySelector('.entry-card.selected')?.classList.contains('read')");
  libraryPageFailure = true;
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '暂时无法载入内容' && !document.querySelector('.reader-view .favorite-button').disabled");
  assert(await evaluate("document.querySelectorAll('.entry-card').length === 0 && document.querySelector('.timeline .count')?.textContent === '0 篇内容'"), "Removing the last visible favorite must also update the displayed count when refresh fails.");
  assert(await evaluate("[...document.querySelectorAll('.library-filter em')].every(item => item.textContent === '—' && item.getAttribute('aria-label') === '计数暂未更新')"), "A failed reload must mark old sidebar counts as unavailable.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const timeline = document.querySelector('.timeline'); const count = timeline.querySelector('.count').getBoundingClientRect(); const retry = timeline.querySelector('.empty-state button').getBoundingClientRect(); const bounds = timeline.getBoundingClientRect(); return timeline.scrollWidth <= timeline.clientWidth + 1 && count.right <= bounds.right + 1 && retry.right <= bounds.right + 1; })()"), "The filtered count and retry action must remain inside the timeline.");
    await writeFile(path.join(tmpdir(), `reading-hub-empty-favorite-${width}.png`), (await window.capturePage()).toPNG());
  }
  libraryPageFailure = false;
  await evaluate("document.querySelector('.reader-view .favorite-button').click()");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 1 && document.querySelector('.timeline .count')?.textContent === '1 篇内容' && !document.querySelector('.reader-view .favorite-button').disabled");
  assert(await evaluate("[...document.querySelectorAll('.library-filter')].find(item => item.querySelector('span')?.textContent === '收藏')?.querySelector('em')?.textContent === '1'"), "Successful reload must restore the confirmed sidebar count.");
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Readable fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article'))");
  delayedNavigationCommand = "dismiss";
  dismissFailure = true;
  await evaluate("document.querySelector('.entry-card.selected .delete-entry').click()");
  await waitFor(window, "document.querySelector('.notice')?.textContent.includes('Synthetic deletion failure') && !document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
  assert(database.listEntries().some((entry) => entry.id === "success"), "A rejected deletion must retain the original card.");
  assert(await evaluate("Boolean(document.querySelector('.reader-article')) && document.querySelector('.entry-card.selected h2')?.textContent === 'Readable fixture' && !document.querySelector('.notice-actions')"), "A rejected deletion must keep the reader open and must not offer an undo for an uncommitted write.");
  dismissFailure = false;
  const dismissalStarted = new Promise((resolve) => { navigationCommandRequested = resolve; });
  await evaluate("document.querySelector('.entry-card.selected .delete-entry').click()");
  await dismissalStarted;
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Historical fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article')) && document.querySelector('.entry-card.selected h2')?.textContent === 'Historical fixture'");
  delayedNavigationCommand = undefined;
  libraryPageFailure = true;
  completeNavigationCommand();
  await waitFor(window, "document.querySelector('.notice')?.textContent.includes('Synthetic library failure') && !document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
  assert(!database.listEntries().some((entry) => entry.id === "success"), "Deletion must remain committed when its list reload fails.");
  libraryPageFailure = false;
  database.publishChanges();
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2 && !document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
  assert(await evaluate("[...document.querySelectorAll('.notice button')].some((button) => button.textContent === '撤销删除')"), "Successful deletion must retain its undo after the failed read model recovers.");
  assert(await evaluate("Boolean(document.querySelector('.reader-article')) && document.querySelector('.entry-card.selected h2')?.textContent === 'Historical fixture'"), "Finishing deletion of the previous article must not close the current reader.");
  smallLibraryPages = true;
  nextLibraryPageFailure = true;
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 1 && Boolean(document.querySelector('.entry-load-more button'))");
  await clickText(".entry-load-more button", "加载更多");
  await waitFor(window, "document.querySelector('.entry-pagination-error')?.textContent.includes('Synthetic next page failure') && !document.querySelector('.entry-load-more button').disabled");
  assert(await evaluate("document.querySelectorAll('.entry-card').length === 1 && [...document.querySelectorAll('.notice button')].some(button => button.textContent === '撤销删除')"), "A page failure must retain loaded cards and the independent deletion undo.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const footer = document.querySelector('.entry-load-more'); footer.scrollIntoView({block:'end'}); const error = footer.querySelector('.entry-pagination-error'); const retry = footer.querySelector('button'); const bounds = document.querySelector('.timeline').getBoundingClientRect(); const rect = retry.getBoundingClientRect(); error.focus(); error.scrollTop = 100; return document.activeElement === error && error.scrollTop > 0 && error.scrollWidth <= error.clientWidth + 1 && footer.scrollWidth <= footer.clientWidth + 1 && rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= innerHeight; })()"), "Long page errors must scroll within the list while retry remains reachable.");
    await writeFile(path.join(tmpdir(), `reading-hub-pagination-${width}.png`), (await window.capturePage()).toPNG());
  }
  nextLibraryPageFailure = false;
  await clickText(".entry-load-more button", "重试加载");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2 && !document.querySelector('.entry-pagination-error')");
  assert(await evaluate("[...document.querySelectorAll('.notice button')].some(button => button.textContent === '撤销删除')"), "A successful page retry must not replace the pending undo.");
  smallLibraryPages = false;
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2 && !document.querySelector('.entry-load-more')");
  await evaluate("document.querySelector('[aria-label=\"在应用内阅读：Historical fixture\"]').click()");
  await waitFor(window, "Boolean(document.querySelector('.reader-article'))");
  restoreFailure = `Synthetic restore failure ${"UnbrokenDiagnostic".repeat(32)}`;
  await clickText(".notice button", "撤销删除");
  await waitFor(window, "document.querySelector('.notice')?.textContent.includes('Synthetic restore failure') && !document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
  assert(await evaluate("[...document.querySelectorAll('.notice button')].some((button) => button.textContent === '撤销删除')"), "A failed undo must retain the retry action.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const notice = document.querySelector('.notice'); const bounds = notice.getBoundingClientRect(); return notice.scrollWidth <= notice.clientWidth + 1 && [...notice.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom; }); })()"), "Long notices must keep undo and close controls inside the notification.");
    assert(await evaluate("(() => { const undo = [...document.querySelectorAll('.notice button')].find(button => button.textContent === '撤销删除'); const style = getComputedStyle(undo); const tokens = getComputedStyle(document.documentElement); return style.fontSize === tokens.getPropertyValue('--control-font-size').trim() && style.fontWeight === '600' && style.minHeight === tokens.getPropertyValue('--control-height').trim() && style.borderRadius === tokens.getPropertyValue('--control-radius').trim(); })()"), "Notice undo must use shared action typography and dimensions.");
    assert(await evaluate("(() => { const message = document.querySelector('.notice-message'); message.focus(); message.scrollTop = 100; return document.activeElement === message && message.scrollTop > 0 && message.scrollWidth <= message.clientWidth + 1 && Boolean(document.querySelector('.notice [aria-label=\"关闭通知\"]')); })()"), "Long notice text must remain readable through its own focusable scroll region.");
    await evaluate("document.querySelector('.notice-message').scrollTop = 0");
    await writeFile(path.join(tmpdir(), `reading-hub-notice-${width}.png`), (await window.capturePage()).toPNG());
  }
  restoreFailure = false;
  await clickText(".notice button", "撤销删除");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3 && document.querySelector('.notice')?.textContent.includes('内容已恢复')");
  assert(database.getEntry("success").favorite, "Undo must restore the original content and preserve its favorite state.");
  await evaluate("document.querySelector('.entry-card.selected .delete-entry').click()");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 2 && !document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
  delayedNavigationCommand = "restore";
  const undoStarted = new Promise((resolve) => { navigationCommandRequested = resolve; });
  await clickText(".notice button", "撤销删除");
  await undoStarted;
  await clickText(".notice button", "×");
  delayedNavigationCommand = undefined;
  completeNavigationCommand();
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3 && !document.querySelector('[aria-label=\"重新载入收件箱\"]').disabled");
  assert(await evaluate("!document.querySelector('.notice')"), "Completing an undo must not resurrect a dismissed notice.");
  database.createSource({ url: "https://example.com/activity", title: "Activity fixture", kind: "generic", pollingEnabled: true });
  database.publishChanges();
  await waitFor(window, "[...document.querySelectorAll('.source-filter')].some((item) => item.textContent.includes('Activity fixture'))");
  await evaluate("[...document.querySelectorAll('.source-filter')].find((item) => item.textContent.includes('Activity fixture')).click()");
  await waitFor(window, "Boolean(document.querySelector('[aria-label=\"刷新 Activity fixture\"]'))");
  delayedNavigationCommand = "refresh";
  const backgroundRefreshStarted = new Promise((resolve) => { navigationCommandRequested = resolve; });
  await evaluate("document.querySelector('[aria-label=\"刷新 Activity fixture\"]').click()");
  await backgroundRefreshStarted;
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  const importStarted = new Promise((resolve) => { importRequested = resolve; });
  await clickText(".dialog-actions button", "导入 OPML…");
  await importStarted;
  assert(await evaluate("document.querySelector('.source-action-status')?.textContent.includes('OPML') && document.querySelector('.connector-form .primary').textContent === '探测来源'"), "OPML import must not be labelled as source probing.");
  completeImport();
  await waitFor(window, "!document.querySelector('.connector-form .primary').disabled");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  assert(await evaluate("document.querySelector('[aria-label=\"刷新 Activity fixture\"]').disabled"), "Finishing OPML import must not clear busy state while another refresh remains pending.");
  delayedNavigationCommand = undefined;
  completeNavigationCommand();
  await waitFor(window, "!document.querySelector('[aria-label=\"刷新 Activity fixture\"]').disabled");
  const previousImports = importRequests;
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  const successfulImportStarted = new Promise((resolve) => { importRequested = resolve; });
  await clickText(".dialog-actions button", "导入 OPML…");
  await successfulImportStarted;
  libraryPageFailure = true;
  completeImport({ cancelled: false, imported: 2, existing: 1, skipped: 1 });
  await waitFor(window, "document.querySelector('.source-action-status')?.textContent === '已导入 2 个 Feed；1 个已存在；跳过 1 个。' && !document.querySelector('.connector-form .primary').disabled");
  assert(await evaluate("!document.querySelector('.connector-form [role=alert]') && document.querySelector('.notice')?.textContent.includes('Synthetic library failure')"), "Committed import counts and a library read failure must retain separate outcomes.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const status = document.querySelector('.source-action-status').getBoundingClientRect(); const dialog = document.querySelector('.dialog').getBoundingClientRect(); return status.width > 0 && status.left >= dialog.left && status.right <= dialog.right && status.top >= dialog.top && status.bottom <= dialog.bottom; })()"), "Import results must remain visible at every viewport.");
    await writeFile(path.join(tmpdir(), `reading-hub-source-results-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  libraryPageFailure = false;
  await evaluate("document.querySelector('[aria-label=\"刷新 Activity fixture\"]').click()");
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '该来源还没有内容'");
  assert(importRequests === previousImports + 1, "Recovering the library must not repeat an already completed import.");
  await clickText(".empty-state button", "查看来源设置");
  await waitFor(window, "Boolean(document.querySelector('.source-settings-form'))");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  await clickText(".library-filter", "全部内容");
  await evaluate("(() => { const input = document.querySelector('.entry-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'NoMatch_abcdefghijklmnopqrstuvwxyz_0123456789_长关键词'.repeat(3)); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '没有找到匹配内容'");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate(`(() => {
      const list = document.querySelector('.entry-list');
      const button = document.querySelector('.empty-state button').getBoundingClientRect();
      return list.scrollWidth <= list.clientWidth + 1 && button.bottom <= innerHeight && button.right <= list.getBoundingClientRect().right + 1;
    })()`), `Long-query empty state and recovery action must fit at ${width}px and ${scale}.`);
    assert(await evaluate(`(() => {
      const button = getComputedStyle(document.querySelector('.empty-state button'));
      const tokens = getComputedStyle(document.documentElement);
      return button.borderRadius === tokens.getPropertyValue('--control-radius').trim()
        && button.minHeight === tokens.getPropertyValue('--control-height').trim()
        && button.fontSize === tokens.getPropertyValue('--control-font-size').trim()
        && button.fontWeight === '600';
    })()`), "Empty-state actions must use shared control typography and dimensions.");
    await writeFile(path.join(tmpdir(), `reading-hub-empty-search-${width}.png`), (await window.capturePage()).toPNG());
  }
  await clickText(".empty-state button", "清除搜索");
  await waitFor(window, "document.querySelectorAll('.entry-card').length === 3");
  assert(await evaluate("document.activeElement.matches('.entry-search input') && document.activeElement.value === ''"), "Clearing an empty search must restore the current list and search focus.");
  emptyLibrary = true;
  await evaluate("document.querySelector('[aria-label=\"重新载入收件箱\"]').click()");
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '添加第一个来源'");
  await clickText(".empty-state button", "添加来源");
  await waitFor(window, "Boolean(document.querySelector('#source-url'))");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  libraryPageFailure = true;
  await evaluate("document.querySelector('[aria-label=\"重新载入收件箱\"]').click()");
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '暂时无法载入内容'");
  await clickText(".notice button", "×");
  assert(await evaluate("document.querySelector('.empty-state h2')?.textContent === '暂时无法载入内容'"), "Dismissing an error notice must not turn a failed load into an empty-library claim.");
  libraryPageFailure = false; pauseLibraryPage = true;
  const retryPageStarted = new Promise((resolve) => { libraryPageRequested = resolve; });
  await clickText(".empty-state button", "重新载入");
  await retryPageStarted;
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '正在载入内容…'");
  pauseLibraryPage = false;
  completeLibraryPage();
  await waitFor(window, "document.querySelector('.empty-state h2')?.textContent === '添加第一个来源'");
  emptyLibrary = false;
  const longSourceTitle = `LongSource${"UnbrokenName".repeat(12)}`;
  const longGroupTitle = `LongGroup${"UnbrokenLabel".repeat(3)}`;
  const longSource = database.createSource({ url: "https://example.com/long-source", title: longSourceTitle, kind: "rss", pollingEnabled: true });
  database.updateSourceSettings(longSource.id, { title: longSourceTitle, category: longGroupTitle, kind: "rss", pollingEnabled: true });
  database.markFailure(database.getSource(longSource.id), `Synthetic source failure ${"UnbrokenDiagnostic".repeat(16)}`);
  database.publishChanges();
  await clickText(".library-filter", "全部内容");
  await waitFor(window, "[...document.querySelectorAll('.source-filter')].some(button => button.querySelector('.source-title')?.textContent.startsWith('LongSource'))");
  await evaluate("[...document.querySelectorAll('.source-filter')].find(button => button.querySelector('.source-title')?.textContent.startsWith('LongSource')).click()");
  await waitFor(window, "document.querySelector('.timeline h1')?.textContent.startsWith('LongSource')");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    await setViewport(width, height, scale);
    assert(await evaluate("(() => { const timeline = document.querySelector('.timeline'); const count = timeline.querySelector('.count').getBoundingClientRect(); const group = [...document.querySelectorAll('.source-group-heading')].find(button => button.textContent.startsWith('LongGroup')); return count.right <= timeline.getBoundingClientRect().right && group.scrollWidth <= group.clientWidth + 1; })()"), "Long source and group names must not hide counts or overflow their columns.");
    assert(await evaluate("!document.querySelector('.timeline [aria-label=\"来源状态\"]') && document.querySelector('.timeline > header').nextElementSibling.classList.contains('entry-search')"), "A source timeline must go directly from its heading to search without a redundant status/settings panel.");
    await writeFile(path.join(tmpdir(), `reading-hub-source-layout-${width}.png`), (await window.capturePage()).toPNG());
  }
  await evaluate("[...document.querySelectorAll('.source-filter')].find(button => button.querySelector('.source-title')?.textContent.startsWith('LongSource')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
  await waitFor(window, "document.querySelector('.source-settings-form input')?.value.startsWith('LongSource')");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  console.log("Reading Hub renderer smoke test: passed; collection/search/read-failure/read-success/read-cancellation/late-read/image-proxy/image-cancellation/late-image/ai-module-deferred-load/ai-module-retry/ai-answer-reuse/ai-error-flush/ai-close-cancellation/unsubscribe/restore/settings-draft/settings-save-lock/settings-close/modal-keyboard/modal-focus/image-preview-dismissal/source-preview-lifetime, library layouts and four academic/settings layouts verified.");
} catch (error) {
  failure = error;
  console.error(error);
  console.error("AI module fixture requests:", { aiRequests, markdownModuleRequests });
  console.error("Renderer fixture console:", messages.slice(-5));
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
