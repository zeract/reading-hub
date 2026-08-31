import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

/**
 * Create an offscreen Chromium host without allowing it to activate Reading
 * Hub. `show: false` alone is not sufficient on macOS: a hidden but focusable
 * NSWindow can still make its application active, which may switch the user
 * back to this app's Space during a scheduled sync.
 *
 * Keep this factory for non-interactive rendering only. Windows opened by a
 * deliberate user action (login, original-page viewer, tray) must use their
 * own visible, focusable options instead.
 */
export function createBackgroundWindow(options: Omit<BrowserWindowConstructorOptions, "show" | "focusable" | "skipTaskbar">): BrowserWindow {
  return new BrowserWindow({
    ...options,
    show: false,
    focusable: false,
    skipTaskbar: true
  });
}
