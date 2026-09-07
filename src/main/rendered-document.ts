import type { WebContents } from "electron";
import { assertPublicUrl } from "../shared/url";
import { formatByteLimit } from "./byte-limit";
import { awaitWithAbort, throwIfAborted, withRequestTimeout } from "./cancellation";

const DEFAULT_DOCUMENT_MAX_BYTES = 8_000_000;
// Separate from the page's world (0), Electron's preload world (999), and
// the range reserved for Chrome extensions. No application APIs are exposed.
const DOCUMENT_WORLD_ID = 1001;

export interface PageRenderOptions {
  signal?: AbortSignal;
  /** Upper bound for HTML transferred out of the isolated renderer. */
  maxBytes?: number;
}

export interface RenderedPage {
  /** Actual loaded address; relative URLs belong to this document. */
  url: string;
  html: string;
}

export class RenderedPageTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`浏览器渲染后的页面仍超过 ${formatByteLimit(maxBytes)}，已停止提取。`);
    this.name = "RenderedPageTooLargeError";
  }
}

/** Capture a bounded DOM using built-ins that page JavaScript cannot replace.
 * The caller owns navigation, access policy and destruction of its window. */
export async function readRenderedPage(contents: Pick<WebContents, "executeJavaScriptInIsolatedWorld" | "getURL">, options?: PageRenderOptions): Promise<RenderedPage> {
  throwIfAborted(options?.signal);
  const requestedLimit = options?.maxBytes;
  const maxBytes = requestedLimit !== undefined && Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit) : DEFAULT_DOCUMENT_MAX_BYTES;
  const request = withRequestTimeout(options?.signal, 5_000, "页面内容读取超时，请重试。");
  try {
    const html: unknown = await awaitWithAbort(contents.executeJavaScriptInIsolatedWorld(DOCUMENT_WORLD_ID, [{ code: `(() => {
      const html = document.documentElement ? document.documentElement.outerHTML : "";
      return new Blob([html]).size <= ${maxBytes} ? html : null;
    })()` }]), request.signal);
    throwIfAborted(request.signal);
    if (html === null) throw new RenderedPageTooLargeError(maxBytes);
    if (typeof html !== "string") throw new Error("页面内容读取失败，请重试。");
    // Defense at the host boundary as well. The isolated-world check keeps
    // normal oversized DOMs from crossing IPC in the first place.
    if (Buffer.byteLength(html, "utf8") > maxBytes) throw new RenderedPageTooLargeError(maxBytes);
    return { html, url: assertPublicUrl(contents.getURL()).toString() };
  } finally {
    request.dispose();
  }
}
