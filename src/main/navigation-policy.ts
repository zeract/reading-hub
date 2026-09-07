import type { WebContents } from "electron";

/** Apply the same document boundary to links, script navigation and redirects.
 * Initial loadURL calls must be validated by the caller. This policy concerns
 * the main document; embedded frames and subresources retain their own policy. */
export function guardMainFrameNavigation(contents: Pick<WebContents, "on">, accepts: (url: string) => boolean): void {
  const guard = (event: Electron.Event, url: string, _isInPlace?: boolean, isMainFrame?: boolean) => {
    if (isMainFrame === false) return;
    try {
      if (accepts(url)) return;
    } catch { /* Invalid destinations are rejected without logging remote data. */ }
    event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
}
