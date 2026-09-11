import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";
import { awaitWithAbort, delayWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";
import { configureChromiumSession } from "./network";
import { RobotsPolicy } from "./robots";
import { createBackgroundWindow } from "./background-window";
import { observeRenderedPage, type RenderedPageCapture, type PageRenderOptions, type RenderedPage } from "./rendered-document";

export { RenderedPageTooLargeError } from "./rendered-document";
export type { PageRenderOptions, RenderedPage } from "./rendered-document";

const RENDER_TIMEOUT_MS = 20_000;
const RENDER_TASK_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MESSAGE = "页面渲染超时，请检查网络后重试。";
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
    const request = withRequestTimeout(options?.signal, RENDER_TASK_TIMEOUT_MS, RENDER_TIMEOUT_MESSAGE);
    let isolatedSession: ReturnType<typeof session.fromPartition> | undefined;
    let window: BrowserWindow | undefined;
    let capture: RenderedPageCapture | undefined;
    let failed = true;
    const stopAndDestroy = () => {
      try {
        if (window && !window.isDestroyed()) window.webContents.stop();
      } catch {
        // Navigation may have already lost its renderer.
      }
      if (window && !window.isDestroyed()) window.destroy();
    };
    try {
      // The whole task, including policy and proxy setup, shares one budget.
      // Rendering must obey the same access policy as the static fetch path.
      await awaitWithAbort(this.robots.assertAllowed(url, { signal: request.signal }), request.signal);
      throwIfAborted(request.signal);
      const partition = `reader-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      isolatedSession = session.fromPartition(partition);
      // A fresh cookie-free partition still needs the approved proxy route.
      await awaitWithAbort(configureChromiumSession(isolatedSession), request.signal);
      throwIfAborted(request.signal);
      isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      isolatedSession.setPermissionCheckHandler(() => false);
      window = createBackgroundWindow({
        webPreferences: {
          partition,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          webviewTag: false,
          spellcheck: false
        }
      });
      capture = observeRenderedPage(window.webContents);
      request.signal.addEventListener("abort", stopAndDestroy, { once: true });
      throwIfAborted(request.signal);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      const pendingResources = await loadWithVerifiedRedirects(window, this.robots, url, request.signal);
      await delayWithAbort(800, request.signal);
      // Electron queues isolated-world evaluation until loading stops. Once
      // the DOM and hydration grace period are complete, cancel remaining
      // subresources so they cannot also stall the bounded DOM snapshot.
      if (pendingResources) await stopRemainingResources(window, request.signal);
      const page = await capture.read({ ...options, signal: request.signal });
      throwIfAborted(request.signal);
      failed = false;
      return page;
    } finally {
      try {
        capture?.dispose();
        request.signal.removeEventListener("abort", stopAndDestroy);
        stopAndDestroy();
        if (isolatedSession) {
          // Always initiate cleanup, including when setup failed before a
          // window existed. A failed task must retain its original error and
          // release its caller even if Chromium cleanup stalls or rejects.
          const cleanup = isolatedSession.clearStorageData();
          if (failed) void cleanup.catch(() => undefined);
          else await awaitWithAbort(cleanup, request.signal);
        }
      } catch (error) {
        if (!failed) throw error;
      } finally {
        request.dispose();
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
async function loadWithVerifiedRedirects(window: BrowserWindow, robots: RobotsPolicy, initialUrl: string, signal?: AbortSignal): Promise<boolean> {
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
    let pendingResources = false;
    try {
      pendingResources = await loadDocument(window, targetUrl, signal);
    } catch (error) {
      if (!redirectedTo) throw error;
    }
    throwIfAborted(signal);
    if (!redirectedTo) return pendingResources;
    targetUrl = assertPublicUrl(redirectedTo).toString();
    redirectCount += 1;
    if (redirectCount > MAX_RENDER_REDIRECTS) throw new Error("页面重定向次数过多，已停止渲染。");
    await awaitWithAbort(robots.assertAllowed(targetUrl, { signal }), signal);
  }
}

/** DOM readiness is independent of slow images/analytics. Keep loading those
 * resources during the hydration grace period, but do not make them a
 * prerequisite for extracting the document. Navigation failures still reject,
 * and the capture separately verifies the main-frame HTTP response. */
async function loadDocument(window: BrowserWindow, url: string, signal?: AbortSignal): Promise<boolean> {
  let ready!: () => void;
  const documentReady = new Promise<void>((resolve) => { ready = resolve; });
  window.webContents.on("dom-ready", ready);
  try {
    return await withTimeout(Promise.race([window.loadURL(url).then(() => false), documentReady.then(() => true)]), RENDER_TIMEOUT_MS, RENDER_TIMEOUT_MESSAGE, signal);
  } finally {
    window.webContents.removeListener("dom-ready", ready);
  }
}

async function stopRemainingResources(window: BrowserWindow, signal?: AbortSignal): Promise<void> {
  if (!window.webContents.isLoading()) return;
  let stopped!: () => void;
  const settled = new Promise<void>((resolve) => { stopped = resolve; });
  window.webContents.on("did-stop-loading", stopped);
  try {
    window.webContents.stop();
    await withTimeout(settled, 5_000, RENDER_TIMEOUT_MESSAGE, signal);
  } finally {
    window.webContents.removeListener("did-stop-loading", stopped);
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  const request = withRequestTimeout(signal, timeoutMs, message);
  return awaitWithAbort(operation, request.signal).finally(() => request.dispose());
}
