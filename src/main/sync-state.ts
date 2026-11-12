import type { ReadingDatabase } from "./database";
import type { Source, Subscription } from "../shared/types";
import { sameSubscriptionScope } from "../shared/subscription-scope";
export class SyncCancelledError extends Error {
}
export function currentSourceForSync(database: ReadingDatabase, initial: Source, initialSubscription?: Subscription): Source {
    const current = database.getSource(initial.id);
    if (!current)
        throw new SyncCancelledError("来源已被删除，已取消此次同步。");
    // An explicit pause is a user/compliance decision, not an error state to be
    // overwritten by an older in-flight response.
    assertSourceEnabled(current);
    if (current.kind !== initial.kind || (current.connectorId ?? current.kind) !== (initial.connectorId ?? initial.kind)) {
        throw new SyncCancelledError("来源类型已更新，已取消旧的同步结果。");
    }
    const currentSubscription = database.getSubscriptionForSource(current.id);
    if (initialSubscription && (!currentSubscription || currentSubscription.id !== initialSubscription.id
        || currentSubscription.accountId !== initialSubscription.accountId
        || currentSubscription.targetId !== initialSubscription.targetId
        || JSON.stringify(currentSubscription.config) !== JSON.stringify(initialSubscription.config)
        || !sameSubscriptionScope(currentSubscription.scope, initialSubscription.scope))) {
        throw new SyncCancelledError("收集范围已更新，已取消旧的同步结果。");
    }
    // A calibration replaces the old cards and is an explicit user decision.
    // Never reinsert an in-flight extraction based on the previous rule.
    if (initial.kind === "generic" && !sameRule(current.extractionRule, initial.extractionRule)) {
        throw new SyncCancelledError("提取规则已更新，已取消旧的同步结果。");
    }
    return current;
}
export function assertSourceEnabled(source: Source): void {
    if (source.subscribed === false || !source.pollingEnabled || source.status === "paused") {
        throw new SyncCancelledError("来源已暂停，已取消此次同步。");
    }
}
function sameRule(left: Source["extractionRule"], right: Source["extractionRule"]): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
