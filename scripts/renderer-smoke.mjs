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
    ingestionKind, contentHash: id, createdAt: Date.now(), read: false, favorite: false }]);
}
database.markFavorite("success", true);
const fixtureImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
let pauseImages = false;
let imageLoads = 0;
let pendingImage;
let imageRequested;
const cancelledImages = new Set();
let pauseRead = false;
let pendingRead;
let readRequested;
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
const fixtureProviders = [
  { id: "openai", label: "Fixture AI", model: "fixture", configured: true, requiresApiKey: true },
  { id: "deepseek", label: "Fixture secondary AI", model: "fixture-secondary", configured: true, requiresApiKey: true }
];
const aiAnswer = "## Fixture answer\n\nInline $x^2$.\n\n$$\ny=x+1\n$$";
const channels = [
  ...["source:update-settings", "source:update-rule"].map((channel) => [channel, () => new Promise((resolve) => {
    managementWrites++;
    completeManagement = () => resolve();
    managementRequested?.();
  })]),
  ["source:calibration", () => ({ title: "Calibration fixture", url: "https://example.com", candidates: [{ label: "Fixture cards", confidence: 0.9, rule: { version: 1, itemRootSelector: "article" }, preview: [] }] })],
  ["source:refresh", () => undefined],
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
  ["ai:list-providers", () => { providerLists++; return fixtureProviders; }],
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
  ["academic:search", (_event, query) => {
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
    assert(typeof requestId === "string" && requestId.startsWith("read-"), "Read IPC must carry an opaque request id.");
    if (pauseRead) return new Promise((resolve) => { pendingRead = { requestId, resolve }; readRequested?.(); });
    if (id === "failure") throw new Error("Deterministic offline fixture");
    return { kind: "article", article: { entryId: id, url: `https://example.com/${id}`, title: "Readable fixture", renderProfile: "standard", contentHtml: '<p>This is a deterministic reader fixture.</p><img src="https://fixture.invalid/body.gif" alt="Deterministic failed image" data-reader-zoomable="true" tabindex="0">' } };
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
async function pressKey(keyCode, modifiers = []) {
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
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
  await evaluate("document.querySelector('[aria-label=\"打开 AI 学习\"]').click()");
  await waitFor(window, "document.querySelector('.reader-ai-panel option')?.textContent.includes('Fixture AI')");
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
  aiMode = "error";
  await evaluate("document.querySelector('.ai-question').requestSubmit()");
  await waitFor(window, "document.querySelector('.ai-message.assistant.error')?.textContent.includes('Fixture partial answer') && document.querySelector('.ai-message.assistant.error')?.textContent.includes('Fixture interruption') && !document.querySelector('#ai-question').disabled");
  aiMode = "pending";
  await evaluate("{ const question = document.querySelector('#ai-question'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(question, 'Pending fixture'); question.dispatchEvent(new Event('input', { bubbles: true })); }");
  await evaluate("{ const form = document.querySelector('.ai-question'); form.requestSubmit(); form.requestSubmit(); }");
  await waitFor(window, "document.querySelector('.ai-message.assistant.is-streaming')?.textContent.includes('Fixture')");
  await evaluate("document.querySelector('[aria-label=\"关闭 AI 学习助手\"]').click()");
  await waitFor(window, "!document.querySelector('.reader-ai-panel')");
  assert(aiRequests === 3 && cancelledAiRequests.has(activeAiRequest), "Closing the assistant must cancel its unfinished request over IPC.");
  window.webContents.send("ai:stream", { requestId: activeAiRequest, type: "delta", text: "Late fixture" });
  aiMode = "complete";
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
    window.setSize(width, height); window.webContents.setZoomFactor(scale);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
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
  const obsoleteSearchStarted = new Promise((resolve) => { academicSearchRequested = resolve; });
  await evaluate(`(() => { const input = document.querySelector('#academic-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Obsolete Author'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await obsoleteSearchStarted;
  await evaluate(`const query = document.querySelector('#academic-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(query, 'Alexander'); query.dispatchEvent(new Event('input', { bubbles: true }));`);
  assert(await evaluate("!document.querySelector('.connector-search button').disabled"), "Editing the author query must allow a replacement search immediately.");
  await evaluate("document.querySelector('.connector-form').requestSubmit()");
  await waitFor(window, "document.querySelectorAll('.academic-results button').length === 20");
  completeObsoleteSearch();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("document.querySelectorAll('.academic-results button').length === 20 && !document.querySelector('.academic-results').textContent.includes('Obsolete author')"), "Late academic results must not replace the current matches.");
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
  const academicSubscriptionStarted = new Promise((resolve) => { academicSubscriptionRequested = resolve; });
  await evaluate("document.querySelector('.academic-results button').click()");
  await academicSubscriptionStarted;
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"添加来源\"]').click()");
  completeAcademicSubscription();
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert(await evaluate("Boolean(document.querySelector('#source-url'))"), "An older academic subscription must not close a replacement add-source dialog.");
  await evaluate("document.querySelector('.dialog [aria-label=\"关闭\"]').click()");
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await clickText(".settings-sidebar nav button", "AI 功能");
  await waitFor(window, "document.querySelectorAll('.settings-ai-form select option').length === 2");
  const listsBeforeSelection = providerLists;
  await evaluate(`(() => { const provider = document.querySelector('.settings-ai-form select'); provider.value = 'deepseek'; provider.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evaluate(`(() => { const input = document.querySelector('.settings-ai-form input:not([type="password"])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'edited-fixture'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert(providerLists === listsBeforeSelection, "Provider selection must not rediscover and overwrite the draft.");
  const saveRequested = new Promise((resolve) => { settingsRequested = resolve; });
  await evaluate(`(() => { const form = document.querySelector('.settings-ai-form'); form.requestSubmit(); form.requestSubmit(); })()`);
  await saveRequested;
  assert(settingsSaves === 1, "Repeated native form submission must issue only one settings command.");
  pendingSettingsSave();
  await waitFor(window, "!document.querySelector('.settings-actions .primary').disabled && document.querySelector('.settings-ai-form input').value === 'edited-fixture'");
  assert(await evaluate("document.querySelector('.settings-ai-form select').value === 'deepseek'"), "Save refresh must preserve the selected provider.");
  for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
    window.setSize(width, height); window.webContents.setZoomFactor(scale);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
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
  database.createSource({ url: "https://example.com/management", title: "Management fixture", kind: "generic", pollingEnabled: true });
  database.publishChanges();
  const openManagement = async () => {
    await waitFor(window, "[...document.querySelectorAll('.source-filter')].some((item) => item.textContent.includes('Management fixture'))");
    await evaluate("[...document.querySelectorAll('.source-filter')].find((item) => item.textContent.includes('Management fixture')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
    await waitFor(window, "Boolean(document.querySelector('.source-settings-form'))");
  };
  for (const mode of ["settings", "calibration"]) {
    await openManagement();
    if (mode === "calibration") {
      await clickText(".source-settings-operations button", "自动校准");
      await waitFor(window, "Boolean(document.querySelector('.calibration-candidate button'))");
    }
    for (const [width, height, scale] of [[1024, 768, 1], [1280, 800, 1], [1440, 900, 1.25], [1720, 1000, 1]]) {
      window.setSize(width, height); window.webContents.setZoomFactor(scale);
      await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
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
