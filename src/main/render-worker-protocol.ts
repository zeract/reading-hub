import { AccessChallengeError } from "./access-challenge";
import { RenderedPageHttpError, RenderedPageTooLargeError } from "./rendered-document";

export const RENDER_FAILURE = "页面渲染进程异常结束，请稍后重试。";
export const RENDER_TIMEOUT = "页面渲染超时，请检查网络后重试。";
const DOCUMENT_FAILURES = [
  "页面在读取过程中发生跳转，请重试。",
  "未能确认页面的 HTTP 响应，已停止提取。",
  "页面内容读取超时，请重试。",
  "页面内容读取失败，请重试。",
  "页面重定向次数过多，已停止渲染。",
  "不能添加本机或私有网络地址。",
  "请输入有效的网址。",
  "仅允许公开 HTTP 或 HTTPS 地址。",
  "网址不能包含用户名或密码，请使用授权连接。"
] as const;
export type WorkerError = { kind: "http" | "size" | "challenge" | "timeout" | "document" | "failed"; value?: number };
export function encodeRenderError(error: unknown): WorkerError {
  if (error instanceof RenderedPageHttpError) return { kind: "http", value: error.status };
  if (error instanceof RenderedPageTooLargeError) return { kind: "size", value: error.maxBytes };
  if (error instanceof AccessChallengeError) return { kind: "challenge" };
  const fixed = error instanceof Error ? DOCUMENT_FAILURES.findIndex(message => message === error.message) : -1;
  if (fixed >= 0) return { kind: "document", value: fixed };
  return { kind: error instanceof Error && error.message === RENDER_TIMEOUT ? "timeout" : "failed" };
}
export function decodeRenderError(error: WorkerError): Error {
  if (error.kind === "http" && Number.isInteger(error.value) && error.value! >= 100 && error.value! <= 599) return new RenderedPageHttpError(error.value!);
  if (error.kind === "size" && Number.isSafeInteger(error.value) && error.value! > 0 && error.value! <= 8_000_000) return new RenderedPageTooLargeError(error.value!);
  if (error.kind === "challenge") return new AccessChallengeError();
  if (error.kind === "document" && Number.isInteger(error.value) && error.value! >= 0 && error.value! < DOCUMENT_FAILURES.length) return new Error(DOCUMENT_FAILURES[error.value!]);
  return new Error(error.kind === "timeout" ? RENDER_TIMEOUT : RENDER_FAILURE);
}
export function workerEnvironment(profile: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { READING_HUB_RENDER_PROFILE: profile };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "DISPLAY", "XDG_RUNTIME_DIR", "SystemRoot", "NO_PROXY", "no_proxy"]) {
    if (env[key]) result[key] = env[key];
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    try {
      const url = new URL(env[key] ?? "");
      if (["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) result[key] = `${url.protocol}//${url.host}`;
    } catch { /* No valid proxy route. Never inherit credentials. */ }
  }
  return result;
}
