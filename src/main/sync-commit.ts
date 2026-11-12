import type { ReadingDatabase } from "./database";
import type { ContentIdentityNamespace, Entry, ReaderArticle, Source, Subscription, SyncResult } from "../shared/types";
import { currentSourceForSync } from "./sync-state";
import { isManualExtractionRule } from "./extraction-rule";
import { canonicalizeContentUrl } from "../shared/url";
import { ContentMaintenance } from "./content-maintenance";
export interface SyncCommitBatch {
    source: Source;
    subscription: Subscription;
    outcome: Omit<SyncResult, "bodies">;
    accepted: Entry[];
    identityNamespaces: readonly ContentIdentityNamespace[];
    bodies?: [
        string,
        ReaderArticle
    ][];
    maintain: boolean;
}
export function commitSyncBatch(db: ReadingDatabase, batch: SyncCommitBatch) {
    const { source, subscription, outcome, accepted, identityNamespaces, maintain } = batch;
    const connectorId = source.connectorId ?? source.kind;
    const bodies = new Map(batch.bodies);
    return db.writeTransaction(() => {
        const currentSource = currentSourceForSync(db, source, subscription);
        let effectiveSource = connectorId === "generic" && outcome.extractionRule
            ? db.replaceAutomaticRule(currentSource.id, outcome.extractionRule)
            : currentSource;
        if (outcome.metadataRevision !== undefined) {
            effectiveSource = db.updateMetadataRevision(effectiveSource.id, outcome.metadataRevision);
        }
        if (outcome.iconUrl)
            effectiveSource = db.updateSourceIcon(effectiveSource.id, outcome.iconUrl);
        // Filter a narrow class of legacy RSS navigation cards only after a
        // successful response. We never delete ordinary entries merely
        // because a paginated Feed no longer returns them.
        if (!outcome.notModified)
            db.deleteNonContentFeedNavigationEntries(effectiveSource, Boolean(effectiveSource.extractionRule?.feedUrl));
        // A connector only maps provider records into the shared shape.  The
        // host owns collection policy so category filters cannot slowly drift
        // across RSS, web, platform, or future adapters.
        const saved = outcome.notModified
            ? { inserted: 0, accepted: 0, identityConflicts: 0 }
            : saveCollectedEntries(db, effectiveSource, accepted, identityNamespaces, bodies);
        db.articles.reconcileSource(effectiveSource.id);
        const inserted = saved.inserted;
        if (connectorId === "generic" && !isManualExtractionRule(effectiveSource.extractionRule) && saved.accepted >= 2) {
            const pageIdentity = canonicalizeContentUrl(effectiveSource.url);
            const identities = new Set(outcome.entries.map(entry => canonicalizeContentUrl(entry.url)));
            if (identities.size >= 2 && !identities.has(pageIdentity))
                db.deleteSupersededSourcePage(effectiveSource);
        }
        if (maintain)
            new ContentMaintenance(db).afterSuccessfulSync(effectiveSource);
        if (outcome.followees)
            db.upsertFollowees(outcome.followees);
        if (outcome.checkpoint)
            db.saveCheckpoint(subscription.id, outcome.checkpoint);
        const updated = db.markSuccess(effectiveSource, {
            collectionComplete: !outcome.notModified && outcome.entries.length > 0,
            etag: outcome.etag,
            lastModified: outcome.lastModified,
            validatorUrl: outcome.validatorUrl,
            empty: !outcome.emptyIsHealthy && !outcome.notModified && outcome.entries.length === 0
        });
        const eventMessage = [
            updated.status === "needs_review" ? "来源需要复核提取规则" : undefined,
            saved.identityConflicts > 0 ? `已跳过 ${saved.identityConflicts} 条身份冲突内容，请检查来源` : undefined,
            outcome.entries.length > 0 && saved.accepted === 0 && subscription.scope.facetSelections.length > 0
                ? "本次内容不在已选分类内；已正常推进同步状态" : undefined
        ].filter(Boolean).join("；") || undefined;
        db.recordSyncEvent(source.id, updated.status === "needs_review" || saved.identityConflicts > 0 ? "warning" : "success", outcome.entries.length, inserted, eventMessage);
        return { inserted, source: updated };
    });
}
export function saveCollectedEntries(db: ReadingDatabase, source: Source, accepted: Entry[], identityNamespaces: readonly ContentIdentityNamespace[], bodies?: Map<string, ReaderArticle>) {
    const saved = db.saveEntriesWithReport(accepted, { collectionKind: db.getCollectionKind(source.id), identityNamespaces, onSaved: (entry, storedId) => {
            const article = bodies?.get(entry.url), saved = article ? db.articles.save(storedId, article) : false;
            db.articles.enqueue(storedId);
            return saved;
        } });
    return { ...saved, accepted: accepted.length };
}
