import { BrowserWindow, session } from "electron";
import { assertPublicUrl } from "../shared/url";
import type { RawEntry } from "../shared/types";
import { extractZhihuFollowPage } from "./zhihu-follow-parser";

const FOLLOW_URL = "https://www.zhihu.com/follow";
const PARTITION = "persist:reading-hub-zhihu-follow";

/**
 * Uses a dedicated Electron session. It never imports the user's browser cookies
 * and never sees a password; Zhihu renders its own user-facing login page.
 */
export class ZhihuFollowConnector {
  private loginWindow?: BrowserWindow;
  private onAuthenticated?: () => Promise<void>;
  private completing?: Promise<void>;

  setOnAuthenticated(callback: () => Promise<void>): void {
    this.onAuthenticated = callback;
  }

  async beginLogin(): Promise<void> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.show();
      this.loginWindow.focus();
      return;
    }
    const loginWindow = this.createWindow(true);
    this.loginWindow = loginWindow;
    const recognizeLogin = (url: string) => {
      void this.maybeCompleteLogin(loginWindow, url).catch((error: unknown) => {
        console.error("Zhihu follow login sync failed:", error instanceof Error ? error.message : "unknown error");
      });
    };
    const cookieStore = session.fromPartition(PARTITION).cookies;
    const recognizeCookie = () => recognizeLogin(loginWindow.webContents.getURL());
    loginWindow.webContents.on("did-navigate", (_event, url) => recognizeLogin(url));
    loginWindow.webContents.on("did-navigate-in-page", (_event, url) => recognizeLogin(url));
    cookieStore.on("changed", recognizeCookie);
    loginWindow.once("closed", () => {
      cookieStore.removeListener("changed", recognizeCookie);
      if (this.loginWindow === loginWindow) this.loginWindow = undefined;
    });
    await loginWindow.loadURL(FOLLOW_URL);
    recognizeLogin(loginWindow.webContents.getURL());
  }

  async fetchEntries(): Promise<RawEntry[]> {
    const window = this.createWindow(false);
    try {
      await window.loadURL(FOLLOW_URL);
      if (!isFollowUrl(window.webContents.getURL())) {
        throw new Error("知乎登录已失效，请点击“重新登录知乎”后再刷新关注动态。");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const html = await window.webContents.executeJavaScript("document.documentElement.outerHTML", true) as string;
      const entries = extractZhihuFollowPage(html, FOLLOW_URL);
      if (!entries.length) throw new Error("未能识别知乎关注动态中的公开内容，请在知乎登录窗口完成登录后重试。");
      return entries;
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /** Renders a followed Zhihu item in the same dedicated, user-authorized session. */
  async renderArticle(rawUrl: string): Promise<string> {
    const url = assertPublicUrl(rawUrl).toString();
    if (!isZhihuUrl(url)) throw new Error("只能在知乎授权会话中打开知乎内容。");
    const window = this.createWindow(false);
    try {
      await window.loadURL(url);
      await new Promise((resolve) => setTimeout(resolve, 900));
      return await window.webContents.executeJavaScript("document.documentElement.outerHTML", true) as string;
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async clearSession(): Promise<void> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close();
    await session.fromPartition(PARTITION).clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"]
    });
  }

  private createWindow(show: boolean): BrowserWindow {
    const window = new BrowserWindow({
      show,
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
    });
    const isolatedSession = session.fromPartition(PARTITION);
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event, url) => {
      if (!isZhihuUrl(url)) event.preventDefault();
    });
    return window;
  }

  private async completeLogin(loginWindow: BrowserWindow): Promise<void> {
    if (this.completing) return this.completing;
    this.completing = (async () => {
      // Let the Follow feed finish its post-login transition before it is rendered offscreen.
      await new Promise((resolve) => setTimeout(resolve, 800));
      await this.onAuthenticated?.();
      if (!loginWindow.isDestroyed()) loginWindow.close();
    })().finally(() => {
      this.completing = undefined;
    });
    return this.completing;
  }

  private async maybeCompleteLogin(loginWindow: BrowserWindow, url: string): Promise<void> {
    if (!isFollowUrl(url) || !(await this.hasAuthenticatedSession())) return;
    await this.completeLogin(loginWindow);
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
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "zhihu.com" || host.endsWith(".zhihu.com");
  } catch {
    return false;
  }
}
