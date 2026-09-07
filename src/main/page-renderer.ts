import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";
import { awaitWithAbort, combineAbortSignals, delayWithAbort, throwIfAborted } from "./cancellation";
import { configureChromiumSession } from "./network";
import { RobotsPolicy } from "./robots";
import { createBackgroundWindow } from "./background-window";
import { readRenderedPage, type PageRenderOptions, type RenderedPage } from "./rendered-document";

export { RenderedPageTooLargeError } from "./rendered-document";
export type { PageRenderOptions, RenderedPage } from "./rendered-document";

const RENDER_TIMEOUT_MS = 20_000;
const MAX_RENDER_REDIRECTS = 5;

export interface PageRenderer {
  render(url: string, options?: PageRenderOptions): Promise<RenderedPage>;
}

/** Uses Electron's Chromium only for public pages that did not yield usable static HTML. */
export class IsolatedPageRenderer implements PageRenderer {
  constructor(private readonly robots = new RobotsPolicy()) {}

  async render(rawUrl: string, options?: PageRenderOptions): Promise<RenderedPage> {
    throwIfAborted(options?.signal);
    const url = assertPublicUrl(rawUrl).toString();
    // Rendering is another fetch path, so it must never bypass the policy the
    // bounded static request already uses. This also protects sources whose
    // persisted rule requires Chromium on every later refresh.
    await this.robots.assertAllowed(url, { signal: options?.signal });
    const partition = `reader-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolatedSession = session.fromPartition(partition);
    // A partitioned session is intentionally isolated from cookies and other
    // browsing state, but it must use the same approved proxy route as the
    // default session. Otherwise terminal-launched development builds bypass
    // HTTP(S)_PROXY only when they fall back to Chromium rendering.
    await awaitWithAbort(configureChromiumSession(isolatedSession), options?.signal);
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    const window = createBackgroundWindow({
      webPreferences: {
        partition,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
        spellcheck: false
      }
    });
    // An audit deadline must close the isolated page rather than merely stop
    // waiting for its Promise. This aborts Chromium navigation immediately,
    // releases the offscreen renderer, and prevents a later fallback stage
    // from keeping the audit process alive.
    const stopAndDestroy = () => {
      try {
        if (!window.isDestroyed()) window.webContents.stop();
      } catch {
        // The renderer may already have gone away while navigation failed.
      }
      if (!window.isDestroyed()) window.destroy();
    };
    options?.signal?.addEventListener("abort", stopAndDestroy, { once: true });
    try {
      throwIfAborted(options?.signal);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      await loadWithVerifiedRedirects(window, this.robots, url, options?.signal);
      await delayWithAbort(800, options?.signal);
      return await readRenderedPage(window.webContents, options);
    } finally {
      options?.signal?.removeEventListener("abort", stopAndDestroy);
      if (!window.isDestroyed()) window.destroy();
      // Chromium teardown is complete once the window has been destroyed. On
      // explicit cancellation do not make an audit wait on cache cleanup; the
      // process-local partition is discarded when the audit exits anyway.
      if (options?.signal?.aborted) {
        void isolatedSession.clearStorageData().catch(() => undefined);
      } else {
        await isolatedSession.clearStorageData();
      }
    }
  }
}

/**
 * BrowserWindow follows redirects itself, which would otherwise skip the
 * public-address and robots checks performed for the initial URL. Intercept
 * main-frame redirects, validate the next target, then deliberately start a
 * fresh isolated navigation. Subframes cannot export HTML to the host and do
 * not become the reader document.
 */
async function loadWithVerifiedRedirects(window: BrowserWindow, robots: RobotsPolicy, initialUrl: string, signal?: AbortSignal): Promise<void> {
  let targetUrl = initialUrl;
  let redirectCount = 0;
  let redirectedTo: string | undefined;
  const interceptRedirect = (event: Electron.Event, nextUrl: string, isInPlace?: boolean, isMainFrame?: boolean) => {
    if (isInPlace || isMainFrame === false) return;
    event.preventDefault();
    redirectedTo = nextUrl;
  };
  window.webContents.on("will-redirect", interceptRedirect);
  window.webContents.on("will-navigate", interceptRedirect);
  while (true) {
    throwIfAborted(signal);
    redirectedTo = undefined;
    try {
      await withTimeout(window.loadURL(targetUrl), RENDER_TIMEOUT_MS, "页面渲染超时，请检查网络后重试。", signal);
    } catch (error) {
      if (!redirectedTo) throw error;
    }
    if (!redirectedTo) return;
    targetUrl = assertPublicUrl(redirectedTo).toString();
    redirectCount += 1;
    if (redirectCount > MAX_RENDER_REDIRECTS) throw new Error("页面重定向次数过多，已停止渲染。");
    await robots.assertAllowed(targetUrl, { signal });
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const combined = combineAbortSignals(signal, deadline.signal);
  const timer = setTimeout(() => deadline.abort(new Error(message)), timeoutMs);
  return awaitWithAbort(operation, combined.signal).finally(() => {
    clearTimeout(timer);
    combined.dispose();
  });
}
