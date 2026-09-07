import { net } from "electron";
import { Readable, Writable } from "node:stream";
import { abortError, throwIfAborted } from "./cancellation";

/** One HTTP hop. Electron's net.fetch rejects manual redirects instead of
 * returning their headers; the host must inspect each hop before following it.
 * Native streams retain backpressure and the caller owns the body deadline. */
export async function chromiumManualFetch(input: string, init: RequestInit): Promise<Response> {
  const normalized = new Request(input, init);
  throwIfAborted(normalized.signal);
  const headers = new Headers(normalized.headers);
  const origin = headers.get("origin") ?? undefined;
  // Match Chromium fetch's main-process credential semantics. API callers
  // explicitly choose omit, so browser sessions cannot authenticate their calls.
  const credentials = normalized.credentials === "same-origin" && !origin ? "include" : normalized.credentials;
  const request = net.request({ url: normalized.url, method: normalized.method,
    headers: Object.fromEntries(headers), origin, credentials, redirect: "manual",
    cache: normalized.cache, referrerPolicy: normalized.referrerPolicy });
  const upload = new AbortController();
  let incoming: Readable | undefined;
  let terminal = false;
  return new Promise<Response>((resolve, reject) => {
    const finish = () => {
      terminal = true;
      normalized.signal.removeEventListener("abort", cancel);
      upload.abort();
    };
    const fail = (error: Error) => {
      if (terminal) return;
      finish(); reject(error);
      incoming?.destroy(error);
      request.abort();
    };
    const cancel = () => fail(abortError(normalized.signal));
    normalized.signal.addEventListener("abort", cancel, { once: true });
    // ClientRequest's Writable can close when upload finishes, before any
    // response arrives. Only response completion or explicit failure ends the
    // HTTP lifetime; retain an error observer for late native failures.
    request.on("error", fail);
    request.once("abort", () => { if (!terminal) fail(new Error("网络请求已取消。")); });
    request.once("redirect", (status, _method, _url, values) => {
      if (terminal) return;
      try {
        const response = new Response(null, { status, headers: responseHeaders(values) });
        finish(); resolve(response); request.abort();
      } catch (error) { fail(error as Error); }
    });
    request.once("response", (message) => {
      if (terminal) return;
      // Electron IncomingMessage is a Node Readable; its public declaration
      // only lists the additional HTTP members.
      incoming = message as unknown as Readable;
      try {
        const empty = normalized.method === "HEAD" || [204, 205, 304].includes(message.statusCode);
        incoming.once("end", finish);
        incoming.once("aborted", () => fail(new Error("网络响应已中断。")));
        incoming.once("error", fail);
        incoming.once("close", () => { if (!terminal) fail(new Error("网络响应已取消。")); });
        const body = empty ? null : Readable.toWeb(incoming, {
          strategy: { highWaterMark: 65_536, size: (chunk: Uint8Array) => chunk.byteLength }
        }) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: message.statusCode, statusText: message.statusMessage, headers: responseHeaders(message.headers) }));
        if (empty) { finish(); request.abort(); }
      } catch (error) { fail(error as Error); }
    });
    if (normalized.signal.aborted) { cancel(); return; }
    if (normalized.body) {
      const writable = Writable.toWeb(request as unknown as Writable) as WritableStream<Uint8Array>;
      void normalized.body.pipeTo(writable, { signal: upload.signal }).catch((error) => fail(error));
    } else request.end();
  });
}

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}
