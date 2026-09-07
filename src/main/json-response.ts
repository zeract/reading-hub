import { throwIfAborted, withRequestTimeout } from "./cancellation";
import { discardResponseBody, formatByteLimit, readResponseBytes } from "./byte-limit";
import { fetchResponse } from "./fetch-response";

const MAX_JSON_BYTES = 8_000_000;

export class InvalidJsonResponseError extends Error {
  constructor() {
    super("接口返回的数据不完整或格式错误，请稍后重试。");
    this.name = "InvalidJsonResponseError";
  }
}

class JsonResponseTooLargeError extends InvalidJsonResponseError {
  constructor() {
    super();
    this.name = "JsonResponseTooLargeError";
    this.message = `接口响应超过 ${formatByteLimit(MAX_JSON_BYTES)} 安全大小限制，已停止读取。`;
  }
}

/** Own the deadline and body through bounded decoding, preserving HTTP failures. */
export async function requestJsonWithTimeout<T>(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  url: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs: number
): Promise<{ response: Response; payload: T }> {
  throwIfAborted(signal);
  const request = withRequestTimeout(signal, timeoutMs, "请求响应超时。");
  let response: Response | undefined;
  try {
    response = await fetchResponse(fetcher, url, { ...init, signal: request.signal });
    throwIfAborted(request.signal);
    let payload: T;
    try {
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new JsonResponseTooLargeError();
      const bytes = await readResponseBytes(response, (_chunk, received) => {
        if (received > MAX_JSON_BYTES) throw new JsonResponseTooLargeError();
      }, request.signal);
      throwIfAborted(request.signal);
      payload = JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (error) {
      throwIfAborted(signal);
      if (response.ok) {
        throwIfAborted(request.signal);
        if (error instanceof JsonResponseTooLargeError) throw error;
        // Never retain remote text or parser/transport exception details.
        throw new InvalidJsonResponseError();
      }
      // HTTP status is authoritative even when its optional error body is
      // malformed, oversized, or stalls until our deadline. Caller cancellation
      // still wins, so abandoned requests never change authorization state.
      payload = {} as T;
    }
    throwIfAborted(signal);
    return { response, payload };
  } finally {
    discardResponseBody(response);
    request.dispose();
  }
}
