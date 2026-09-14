import { BrowserWindow, session } from "electron";
import { load } from "cheerio";
import { assertPublicUrl } from "../shared/url";
import type { ConnectorAdapter, RawEntry, Source, SyncContext, SyncResult } from "../shared/types";
import { builtInManifest } from "./connector-registry";
import { contentNormalizer } from "./content-normalizer";
import { abortError, awaitWithAbort, combineAbortSignals, delayWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";
import { extractZhihuFollowPage, isZhihuContentUrl } from "./zhihu-follow-parser";
import { configureChromiumSession } from "./network";
import { createBackgroundWindow } from "./background-window";
import { guardMainFrameNavigation } from "./navigation-policy";
import { observeRenderedPage, type RenderedPageCapture, type PageRenderOptions, type RenderedPage } from "./rendered-document";
import { zhihuAnswerContentReadiness, zhihuAnswerId } from "./zhihu-answer-identity";

const FOLLOW_URL = "https://www.zhihu.com/follow";
const PARTITION = "persist:reading-hub-zhihu-follow";
const READING_TIMEOUT_MS = 30_000;
const NON_ANSWER_SETTLE_MS = 900;
const ANSWER_HYDRATION_TIMEOUT_MS = 5_000;
const ANSWER_HYDRATION_POLL_MS = 250;

class ZhihuAnswerBodyUnavailableError extends Error {
  constructor() {
    super("知乎回答正文仍未加载；请重试，或在浏览器中打开原文。");
    this.name = "ZhihuAnswerBodyUnavailableError";
  }
}

type LoginAttempt = {
  controller: AbortController;
  opening: Promise<void>;
  window?: BrowserWindow;
  completing?: Promise<void>;
  dispose?: () => void;
};

/**
 * Uses a dedicated Electron session. It never imports the user's browser cookies
 * and never sees a password; Zhihu renders its own user-facing login page.
 */
export class ZhihuFollowConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("zhihu_follow", "知乎关注动态", ["oauth"], ["www.zhihu.com"]);

  private login?: LoginAttempt;
  private onAuthenticated?: () => Promise<void>;
  private clearing?: Promise<void>;
  private readingSession = new AbortController();
  private closed = false;

  setOnAuthenticated(callback: () => Promise<void>): void {
    this.onAuthenticated = callback;
  }

  async beginLogin(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed) throw new Error("应用正在退出，无法打开知乎登录窗口。");
    if (this.login) {
      this.login.window?.show();
      this.login.window?.focus();
      return awaitWithAbort(this.login.opening, signal);
    }
    const attempt: LoginAttempt = { controller: new AbortController(), opening: Promise.resolve() };
    this.login = attempt;
    const cancel = () => this.cancelLogin(attempt);
    signal?.addEventListener("abort", cancel, { once: true });
    attempt.opening = this.openLogin(attempt).catch(() => {
      const error = attempt.controller.signal.aborted
        ? abortError(attempt.controller.signal)
        : new Error("无法打开知乎登录窗口，请检查网络后重试。");
      this.cancelLogin(attempt);
      throw error;
    }).finally(() => signal?.removeEventListener("abort", cancel));
    return attempt.opening;
  }

  private async openLogin(attempt: LoginAttempt): Promise<void> {
    const signal = attempt.controller.signal;
    throwIfAborted(signal);
    const loginWindow = await this.createWindow(true, signal);
    attempt.window = loginWindow;
    throwIfAborted(signal);
    const recognizeLogin = (url: string) => {
      void this.maybeCompleteLogin(attempt, url).catch(() => {
        if (!signal.aborted) console.error("知乎登录识别或首次同步失败，请重新登录后重试。");
      });
    };
    const cookieStore = session.fromPartition(PARTITION).cookies;
    const recognizeCookie = () => {
      if (this.isActiveLogin(attempt)) recognizeLogin(loginWindow.webContents.getURL());
    };
    loginWindow.webContents.on("did-navigate", (_event, url) => recognizeLogin(url));
    loginWindow.webContents.on("did-navigate-in-page", (_event, url) => recognizeLogin(url));
    cookieStore.on("changed", recognizeCookie);
    attempt.dispose = () => {
      cookieStore.removeListener("changed", recognizeCookie);
    };
    loginWindow.once("closed", () => this.cancelLogin(attempt));
    await awaitWithAbort(loginWindow.loadURL(FOLLOW_URL), signal);
    throwIfAborted(signal);
    recognizeLogin(loginWindow.webContents.getURL());
  }

  async fetchEntries(signal?: AbortSignal): Promise<RawEntry[]> {
    return this.withReadingWindow(signal, async (window, signal, capture) => {
      await awaitWithAbort(window.loadURL(FOLLOW_URL), signal);
      if (!isFollowUrl(window.webContents.getURL())) {
        throw new Error("知乎登录已失效，请点击“重新登录知乎”后再刷新关注动态。");
      }
      await delayWithAbort(1_200, signal);
      const page = await capture.read({ signal });
      if (!isFollowUrl(page.url)) throw new Error("知乎登录已失效，请点击“重新登录知乎”后再刷新关注动态。");
      const entries = extractZhihuFollowPage(page.html, page.url);
      if (!entries.length) throw new Error("未能识别知乎关注动态中的公开内容，请在知乎登录窗口完成登录后重试。");
      return entries;
    });
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    return { entries: await this.fetchEntries(context.signal), emptyIsHealthy: true };
  }

  normalize(item: RawEntry, source: Source) {
    return contentNormalizer.normalize(item, source, { providerId: "zhihu_follow", providerLabel: "知乎" });
  }

  /** Renders a followed Zhihu item in the same dedicated, user-authorized session. */
  async renderArticle(rawUrl: string, options?: PageRenderOptions): Promise<RenderedPage> {
    throwIfAborted(options?.signal);
    const url = assertPublicUrl(rawUrl).toString();
    if (!isZhihuUrl(url)) throw new Error("只能在知乎授权会话中打开知乎内容。");
    if (!isZhihuContentUrl(url)) throw new Error("这条旧记录指向知乎列表或导航页，不是文章链接；请刷新信源后打开具体文章。");
    return this.withReadingWindow(options?.signal, async (window, signal, capture) => {
      await awaitWithAbort(window.loadURL(url), signal);
      const page = await this.readArticleWhenReady(capture, url, { ...options, signal });
      if (!isZhihuUrl(page.url)) throw new Error("只能在知乎授权会话中打开知乎内容。");
      if (/^\/(?:signin|signup|login)(?:\/|$)/.test(new URL(page.url).pathname)) throw new Error("知乎登录已失效或当前会话未登录，请点击“重新登录知乎”后重试。");
      if (!isZhihuContentUrl(page.url)) throw new Error("知乎未返回文章页面，请在原文中确认登录与内容是否可用。");
      return page;
    });
  }

  /**
   * A successful navigation only proves that Zhihu returned a document. The
   * answer body is populated by hydration afterwards, so capture only when
   * the requested answer's own authored container is non-empty. The loop is
   * bounded by the surrounding 30-second reading request and never executes
   * page code or follows a new URL.
   */
  private async readArticleWhenReady(capture: RenderedPageCapture, requestedUrl: string, options: PageRenderOptions): Promise<RenderedPage> {
    const expectedAnswerId = zhihuAnswerId(requestedUrl);
    // Keep the established settle window for columns and videos. Answer URLs
    // have a stronger, target-specific readiness condition below; applying
    // that condition to every Zhihu content type would make those pages race
    // their own hydration.
    if (!expectedAnswerId) {
      await delayWithAbort(NON_ANSWER_SETTLE_MS, options.signal);
      return capture.read(options);
    }

    let page = await capture.read(options);
    if (zhihuAnswerId(page.url) !== expectedAnswerId) return page;

    const deadline = Date.now() + ANSWER_HYDRATION_TIMEOUT_MS;
    let sawAnswerShell = false;
    while (true) {
      const readiness = zhihuAnswerContentReadiness(load(page.html), requestedUrl);
      if (readiness === "ready") return page;
      if (readiness === "pending") sawAnswerShell = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (sawAnswerShell) throw new ZhihuAnswerBodyUnavailableError();
        // Preserve the strict identity diagnostic from ArticleReader when no
        // matching answer appeared at all; a loading timeout must not imply a
        // different answer is safe to display.
        return page;
      }
      await delayWithAbort(Math.min(ANSWER_HYDRATION_POLL_MS, remaining), options.signal);
      page = await capture.read(options);
      if (zhihuAnswerId(page.url) !== expectedAnswerId) return page;
    }
  }

  /** Reading windows belong to both their caller and the current session.
   * Clearing authentication invalidates configuration, navigation and DOM
   * extraction together, including callers without their own signal. */
  private async withReadingWindow<T>(caller: AbortSignal | undefined, operation: (window: BrowserWindow, signal: AbortSignal, capture: RenderedPageCapture) => Promise<T>): Promise<T> {
    const scope = combineAbortSignals(caller, this.readingSession.signal);
    // One budget includes admission, proxy configuration, navigation and DOM
    // extraction. A stalled background read must release its sync queue slot.
    const request = withRequestTimeout(scope.signal, READING_TIMEOUT_MS, "知乎内容读取超时，请检查网络后重试。");
    const signal = request.signal;
    try {
      const window = await this.createWindow(false, signal);
      const capture = observeRenderedPage(window.webContents);
      try {
        throwIfAborted(signal);
        const result = await awaitWithAbort(operation(window, signal, capture), signal);
        throwIfAborted(signal);
        return result;
      } finally {
        capture.dispose();
        if (!window.isDestroyed()) window.destroy();
      }
    } finally { request.dispose(); scope.dispose(); }
  }

  clearSession(): Promise<void> {
    // New login/reading windows must wait for all queued storage deletions.
    const clearing = (this.clearing ?? Promise.resolve()).catch(() => undefined).then(() => session.fromPartition(PARTITION).clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"]
    })).then(() => {
      if (this.clearing === clearing) this.clearing = undefined;
    }, () => {
      // Keep a failed deletion as an admission barrier until a retry succeeds;
      // a fresh reader must not silently reuse partially cleared credentials.
      throw new Error("知乎会话清理失败，请重试取消订阅。");
    });
    this.clearing = clearing;
    const previousSession = this.readingSession;
    this.readingSession = new AbortController();
    previousSession.abort(new Error("知乎授权会话正在清理，已取消此次读取。"));
    if (this.login) this.cancelLogin(this.login);
    return clearing;
  }

  /** Stop session windows before shutdown drains requests and closes SQLite. */
  close(): void {
    this.closed = true;
    this.readingSession.abort(new Error("应用正在退出，已取消知乎读取。"));
    if (this.login) this.cancelLogin(this.login);
    this.onAuthenticated = undefined;
  }

  private cancelLogin(attempt: LoginAttempt): void {
    if (this.login === attempt) this.login = undefined;
    attempt.controller.abort(new Error("知乎登录已取消。"));
    attempt.dispose?.();
    attempt.dispose = undefined;
    if (attempt.window && !attempt.window.isDestroyed()) attempt.window.destroy();
  }

  private async createWindow(show: boolean, signal?: AbortSignal): Promise<BrowserWindow> {
    if (this.closed) throw new Error("应用正在退出，无法打开知乎窗口。");
    while (this.clearing) await awaitWithAbort(this.clearing, signal);
    throwIfAborted(signal);
    const isolatedSession = session.fromPartition(PARTITION);
    // The authorised session remains separate from Chrome and the app's normal
    // session, while retaining the user's explicit HTTP(S)_PROXY route.
    await awaitWithAbort(configureChromiumSession(isolatedSession), signal);
    throwIfAborted(signal);
    if (this.closed) throw new Error("应用正在退出，无法打开知乎窗口。");
    const windowOptions = {
      width: 960,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      title: "登录知乎以同步关注动态",
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
        spellcheck: false
      }
    };
    // Feed/article rendering runs on the timer, so it must never activate this
    // app or pull macOS back to Reading Hub's current Space. The login window
    // remains a normal, visible window because opening it is a user action.
    const window = show
      ? new BrowserWindow({ ...windowOptions, show: true })
      : createBackgroundWindow(windowOptions);
    const stopAndDestroy = () => {
      try { if (!window.isDestroyed()) window.webContents.stop(); }
      catch { /* The renderer may already have exited. */ }
      if (!window.isDestroyed()) window.destroy();
    };
    // Install ownership before returning across an await boundary. A clear
    // between creation and the caller's continuation must destroy this window.
    if (signal) {
      signal.addEventListener("abort", stopAndDestroy, { once: true });
      window.once("closed", () => signal.removeEventListener("abort", stopAndDestroy));
    }
    try {
      throwIfAborted(signal);
      isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      isolatedSession.setPermissionCheckHandler(() => false);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      guardMainFrameNavigation(window.webContents, isZhihuUrl);
      return window;
    } catch (error) { stopAndDestroy(); throw error; }
  }

  private async completeLogin(attempt: LoginAttempt): Promise<void> {
    if (attempt.completing) return attempt.completing;
    attempt.completing = (async () => {
      // Let the Follow feed finish its post-login transition before it is rendered offscreen.
      await delayWithAbort(800, attempt.controller.signal);
      if (!this.isActiveLogin(attempt) || !isFollowUrl(attempt.window!.webContents.getURL())) return;
      await this.onAuthenticated?.();
      this.cancelLogin(attempt);
    })().finally(() => {
      attempt.completing = undefined;
    });
    return attempt.completing;
  }

  private isActiveLogin(attempt: LoginAttempt): boolean {
    return this.login === attempt && !attempt.controller.signal.aborted && Boolean(attempt.window && !attempt.window.isDestroyed());
  }

  private async maybeCompleteLogin(attempt: LoginAttempt, url: string): Promise<void> {
    if (!this.isActiveLogin(attempt) || !isFollowUrl(url)) return;
    const authenticated = await awaitWithAbort(this.hasAuthenticatedSession(), attempt.controller.signal);
    if (!authenticated || !this.isActiveLogin(attempt)) return;
    await this.completeLogin(attempt);
  }

  private async hasAuthenticatedSession(): Promise<boolean> {
    // Only the cookie name is consulted. The token value remains in Chromium's
    // encrypted session storage and is never copied into app state or logs.
    const cookies = await session.fromPartition(PARTITION).cookies.get({ url: FOLLOW_URL });
    return cookies.some((cookie) => cookie.name === "z_c0" || cookie.name === "z_c0_2");
  }
}

function isFollowUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname === "www.zhihu.com" && (url.pathname === "/follow" || url.pathname.startsWith("/follow/"));
  } catch {
    return false;
  }
}

function isZhihuUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === "zhihu.com" || host.endsWith(".zhihu.com");
  } catch {
    return false;
  }
}
