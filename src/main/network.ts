import { net } from "electron";

/**
 * Electron's Chromium network stack honours macOS proxy configuration. Node's
 * built-in fetch does not, which makes otherwise reachable sites fail on many
 * managed or proxy-based networks.
 */
export function chromiumFetch(input: string, init?: RequestInit) {
  return net.fetch(input, init);
}
