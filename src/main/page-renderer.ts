import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";
import { awaitWithAbort, combineAbortSignals, delayWithAbort, throwIfAborted } from "./cancellation";
import { configureChromiumSession } from "./network";

const RENDER_TIMEOUT_MS = 20_000;

export interface PageRenderOptions {
  /** Optional caller-owned cancellation. Omitted for normal reader requests. */
  signal?: AbortSignal;
}

export interface PageRenderer {
  render(url: string, options?: PageRenderOptions): Promise<string>;
}

/** Uses Electron's Chromium only for public pages that did not yield usable static HTML. */
export class IsolatedPageRenderer implements PageRenderer {
  async render(rawUrl: string, options?: PageRenderOptions): Promise<string> {
    throwIfAborted(options?.signal);
    const url = assertPublicUrl(rawUrl).toString();
    const partition = `reader-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolatedSession = session.fromPartition(partition);
    // A partitioned session is intentionally isolated from cookies and other
    // browsing state, but it must use the same approved proxy route as the
    // default session. Otherwise terminal-launched development builds bypass
    // HTTP(S)_PROXY only when they fall back to Chromium rendering.
    await awaitWithAbort(configureChromiumSession(isolatedSession), options?.signal);
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({
      show: false,
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
      await withTimeout(window.loadURL(url), RENDER_TIMEOUT_MS, "页面渲染超时，请检查网络后重试。", options?.signal);
      await delayWithAbort(800, options?.signal);
      return await withTimeout(window.webContents.executeJavaScript("document.documentElement.outerHTML", true), 5_000, "页面内容读取超时，请重试。", options?.signal);
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

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const combined = combineAbortSignals(signal, deadline.signal);
  const timer = setTimeout(() => deadline.abort(new Error(message)), timeoutMs);
  return awaitWithAbort(operation, combined.signal).finally(() => {
    clearTimeout(timer);
    combined.dispose();
  });
}
