import { assertPublicUrl } from "../shared/url";
import { discardResponseBody } from "./byte-limit";
import { throwIfAborted } from "./cancellation";
import { fetchResponse } from "./fetch-response";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export class ApiRequestBoundaryError extends Error {
  constructor(message = "接口重定向超出允许范围，已停止请求。") {
    super(message);
    this.name = "ApiRequestBoundaryError";
  }
}

function publicHttpsUrl(value: string): URL {
  try {
    const url = assertPublicUrl(new URL(value).toString());
    if (url.protocol !== "https:") throw new Error();
    return url;
  } catch {
    throw new ApiRequestBoundaryError();
  }
}

/** API credentials and bodies may only follow redirects within the initial
 * approved HTTPS origin. The caller owns the deadline and final response body. */
export async function fetchApiResponse(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit
): Promise<Response> {
  const signal = init.signal ?? undefined;
  throwIfAborted(signal);
  let target = publicHttpsUrl(url);
  const origin = target.origin;
  let request = { ...init, redirect: "manual" as const };
  for (let redirects = 0; ; redirects++) {
    let response: Response | undefined = await fetchResponse(fetcher, target.toString(), request);
    try {
      throwIfAborted(signal);
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
      if (location === null) {
        const result = response;
        response = undefined;
        return result;
      }
      if (redirects >= MAX_REDIRECTS) throw new ApiRequestBoundaryError("接口重定向次数过多，已停止请求。");
      let next: URL;
      try {
        next = publicHttpsUrl(new URL(location, target).toString());
      } catch {
        throw new ApiRequestBoundaryError();
      }
      if (next.origin !== origin) throw new ApiRequestBoundaryError();
      // Fetch cannot replay a consumed stream (303 discards it instead).
      if (response.status !== 303 && request.body instanceof ReadableStream) {
        throw new ApiRequestBoundaryError("接口重定向无法重放流式请求，已停止请求。");
      }
      const method = (request.method ?? "GET").toUpperCase();
      if (((response.status === 301 || response.status === 302) && method === "POST")
        || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
        const headers = new Headers(request.headers);
        for (const name of ["content-encoding", "content-language", "content-location", "content-type", "content-length"]) headers.delete(name);
        request = { ...request, method: "GET", body: undefined, headers };
      }
      target = next;
    } finally {
      discardResponseBody(response);
    }
  }
}
