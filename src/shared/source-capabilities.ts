import type { Source } from "./types";

/** Shared presentation of source lifecycle and available user operations. */
export function isRetiredXPublicProfile(source: Source | undefined): boolean {
  return source?.kind === "x" && source.connectorId === "x" && source.config?.mode === "public-profile";
}

export function sourceCapabilities(source: Source) {
  const retired = isRetiredXPublicProfile(source);
  const canPoll = source.subscribed !== false && source.kind !== "manual" && !retired;
  return {
    canPoll,
    canRefresh: canPoll && source.pollingEnabled && source.status !== "paused",
    canCalibrate: source.subscribed !== false && source.kind === "generic",
    canReconnect: source.subscribed !== false && source.kind === "zhihu_follow",
    canSubscribe: !retired,
    canChangeKind: ["rss", "generic", "manual"].includes(source.kind) && source.config?.sourceProvider !== "rsshub"
  };
}

export function sourceHealthLabel(source: Source): string {
  if (source.subscribed === false) return "已取消订阅";
  if (source.kind === "manual") return "已保存链接";
  if (source.status === "needs_review") return "需要校准";
  if (source.status === "error") return "同步失败";
  if (!source.pollingEnabled || source.status === "paused") return "已暂停";
  return source.lastCheckedAt ? "正常同步" : "等待首次同步";
}
