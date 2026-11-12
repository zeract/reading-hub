import type { ReadingDatabase } from "./database";
import type { RewriteStore } from "./persistence/rewrite-store";
/** Host-owned semantic operations only. No SQL, closures or remote names. */
export const databaseWriteMethods = ["markRead", "markFavorite", "beginLibrarySession", "createSource", "createSources", "createSourceWithEntries", "updateSourceSettings", "pauseSource", "resumeLegacyAutoPausedSources", "setSubscribed", "deleteSource", "dismissEntry", "restoreEntry", "updateSubscriptionScope", "saveAccount", "deleteAccount", "expediteNetworkFailures", "rescheduleLegacyRobotsFailure", "updateCalibratedRule", "commitSync", "commitSyncFailure", "prepareSourceMaintenance", "runStartupMaintenance"] as const satisfies readonly (keyof ReadingDatabase)[];
export type DatabaseWriteMethod = typeof databaseWriteMethods[number];
export const rewriteMethods = ["settings", "configure", "get", "enqueue", "next", "recover", "progress", "finish", "checkpoint", "checkpointDocument", "saveCheckpoint", "hasLegacyCheckpoint", "structuredCheckpoint", "saveStructuredCheckpoint", "cancel", "remove", "fail"] as const satisfies readonly (keyof RewriteStore)[];
export type RewriteMethod = typeof rewriteMethods[number];
export const libraryWriteErrors = ["只有普通网页来源需要校准。", "来源已取消订阅，请重新订阅后再校准。", "来源不存在。", "来源分类最多 60 个字符。", "无法保存文章分类。", "账号仍被来源引用，不能删除。", "这篇内容已不存在。请刷新列表后重试。", "这篇内容已合并或不存在，请从最近删除列表中重新选择。", "改写队列已满，请等待部分文章完成后再试。"] as const;
