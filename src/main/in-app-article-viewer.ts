import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";

/**
 * User-initiated, in-app navigation used when a site forbids automated text
 * extraction. It is deliberately a temporary browser session: no app preload,
 * Node access, permissions, popups, or persistent login state.
 */
export class InAppArticleViewer {
  open(rawUrl: string, entryTitle: string): void {
    const url = assertPublicUrl(rawUrl).toString();
    const partition = `reader-article-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isolatedSession = session.fromPartition(partition);
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);

    const window = new BrowserWindow({
      show: true,
      width: 1080,
      height: 820,
      minWidth: 760,
      minHeight: 560,
      title: `Reading Hub · ${compactTitle(entryTitle)}`,
      backgroundColor: "#ffffff",
      webPreferences: {
        partition,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
        spellcheck: false
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event, nextUrl) => {
      try {
        assertPublicUrl(nextUrl);
      } catch {
        event.preventDefault();
      }
    });
    window.webContents.on("page-title-updated", (_event, pageTitle) => {
      window.setTitle(`Reading Hub · ${compactTitle(pageTitle || entryTitle)}`);
    });
    window.once("closed", () => {
      void isolatedSession.clearStorageData().catch(() => undefined);
    });
    void window.loadURL(url).catch(() => undefined);
  }
}

function compactTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || "原文";
}
