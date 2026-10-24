/** Stable, redacted transport messages also identify sources safe to retry on reconnection. */
export const NETWORK_REQUEST_MESSAGES = {
  proxy: "无法连接到配置的代理服务器。请确认代理正在运行，或检查系统/环境代理设置后重试。",
  dns: "无法解析该站点的域名。请检查 DNS、VPN 或网络设置后重试。",
  timeout: "该站点响应超时。请稍后重试，或检查网络与代理设置。",
  connection: "无法连接到该站点。请检查网络或系统代理设置后重试。"
} as const;

export function networkFailureKind(cause: unknown): NetworkFailureKind {
  const details = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause || "");
  if (/ERR_(?:PROXY|TUNNEL|SOCKS)_|proxy/i.test(details)) return "proxy";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|dns/i.test(details)) return "dns";
  if (/ERR_TIMED_OUT|timeout|timed out|aborted/i.test(details)) return "timeout";
  return "connection";
}

export type NetworkFailureKind = keyof typeof NETWORK_REQUEST_MESSAGES;
