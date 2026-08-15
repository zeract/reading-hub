import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";

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
      await window.loadURL(url);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return await window.webContents.executeJavaScript("document.documentElement.outerHTML", true);
    } finally {
      if (!window.isDestroyed()) window.destroy();
      await isolatedSession.clearStorageData();
    }
  }
}
