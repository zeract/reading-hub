import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";

const RENDER_TIMEOUT_MS = 20_000;

export interface PageRenderer {
  render(url: string): Promise<string>;
}

/** Uses Electron's Chromium only for public pages that did not yield usable static HTML. */
export class IsolatedPageRenderer implements PageRenderer {
  async render(rawUrl: string): Promise<string> {
    const url = assertPublicUrl(rawUrl).toString();
    const partition = `reader-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolatedSession = session.fromPartition(partition);
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
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      await withTimeout(window.loadURL(url), RENDER_TIMEOUT_MS, "页面渲染超时，请检查网络后重试。");
      await new Promise((resolve) => setTimeout(resolve, 800));
      return await withTimeout(window.webContents.executeJavaScript("document.documentElement.outerHTML", true), 5_000, "页面内容读取超时，请重试。");
    } finally {
      if (!window.isDestroyed()) window.destroy();
      await isolatedSession.clearStorageData();
    }
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
