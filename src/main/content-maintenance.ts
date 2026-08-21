import type { Source } from "../shared/types";
import { ReadingDatabase } from "./database";

/**
 * Increment this only when a newly introduced, idempotent repair must be
 * replayed for every existing source. New collection logic belongs in a
 * connector; this service is intentionally for historical local data only.
 */
export const SOURCE_CONTENT_MAINTENANCE_REVISION = 1;

export type ContentMaintenanceReport = {
  inspectedSources: number;
  maintainedSources: number;
  skippedSources: number;
  taxonomyEntriesRemoved: number;
  homepageUrlsRepaired: number;
  scourEntriesMerged: number;
  zhihuIdeasRemoved: number;
  zhihuPromotionsRemoved: number;
  failures: Array<{ sourceId: string; message: string }>;
};

export type SourceMaintenanceResult = {
  sourceId: string;
  skipped: boolean;
  taxonomyEntriesRemoved: number;
  homepageUrlsRepaired: number;
  scourEntriesMerged: number;
  zhihuIdeasRemoved: number;
  zhihuPromotionsRemoved: number;
};

/**
 * Runs source-scoped, one-time repairs outside normal synchronization.
 *
 * Each task is idempotent, and its revision is written only after all repairs
 * for that source succeed. A source removed later automatically loses its
 * marker through the `source_maintenance` foreign key.
 */
export class ContentMaintenance {
  constructor(private readonly database: ReadingDatabase) {}

  runStartupMaintenance(): ContentMaintenanceReport {
    const report: ContentMaintenanceReport = {
      inspectedSources: 0,
      maintainedSources: 0,
      skippedSources: 0,
      taxonomyEntriesRemoved: 0,
      homepageUrlsRepaired: 0,
      scourEntriesMerged: 0,
      zhihuIdeasRemoved: 0,
      zhihuPromotionsRemoved: 0,
      failures: []
    };
    for (const source of this.database.listSources()) {
      if (!requiresMaintenance(source)) continue;
      report.inspectedSources += 1;
      if ((this.database.getSourceMaintenanceRevision(source.id) ?? 0) >= SOURCE_CONTENT_MAINTENANCE_REVISION) {
        report.skippedSources += 1;
        continue;
      }
      try {
        const result = this.applySourceMaintenance(source);
        addToReport(report, result);
        this.database.markSourceMaintenanceRevision(source.id, SOURCE_CONTENT_MAINTENANCE_REVISION);
        report.maintainedSources += 1;
      } catch (error) {
        // A malformed legacy row should not keep the reader from starting.
        // Do not stamp the marker: a later release can retry the repair.
        report.failures.push({
          sourceId: source.id,
          message: error instanceof Error ? error.message.slice(0, 300) : "维护本地历史内容时发生未知错误。"
        });
      }
    }
    return report;
  }

  /**
   * Compatibility hook for a sync lifecycle. It only reads the per-source
   * marker after startup maintenance has completed, so the old table scans do
   * not remain on every ordinary refresh.
   */
  prepareForSync(source: Source): SourceMaintenanceResult {
    return this.applySourceMaintenance(source);
  }

  /**
   * Run one final, idempotent pass after a source was successfully saved, then
   * mark this historical revision complete. This retains the old pre/post-sync
   * safety ordering for databases opened outside the normal app bootstrap.
   */
  afterSuccessfulSync(source: Source): SourceMaintenanceResult {
    const result = this.applySourceMaintenance(source);
    if (!result.skipped) this.database.markSourceMaintenanceRevision(source.id, SOURCE_CONTENT_MAINTENANCE_REVISION);
    return result;
  }

  private applySourceMaintenance(source: Source): SourceMaintenanceResult {
    if (!requiresMaintenance(source)) return emptyResult(source.id, true);
    if ((this.database.getSourceMaintenanceRevision(source.id) ?? 0) >= SOURCE_CONTENT_MAINTENANCE_REVISION) {
      return emptyResult(source.id, true);
    }
    const result = emptyResult(source.id, false);
    const connectorId = source.connectorId ?? source.kind;
    if (connectorId === "generic") {
      result.taxonomyEntriesRemoved = this.database.deleteTaxonomyEntries(source.id);
      result.homepageUrlsRepaired = this.database.repairGenericHomepageEntryUrls(source);
    }
    if (connectorId === "rss") {
      result.scourEntriesMerged = this.database.repairScourRedirectEntries(source.id);
    }
    if (source.kind === "zhihu_follow") {
      result.zhihuIdeasRemoved = this.database.deleteUnsupportedZhihuFollowEntries(source.id);
      result.zhihuPromotionsRemoved = this.database.deletePromotedZhihuFollowEntries(source.id);
    }
    return result;
  }
}

function emptyResult(sourceId: string, skipped: boolean): SourceMaintenanceResult {
  return {
    sourceId,
    skipped,
    taxonomyEntriesRemoved: 0,
    homepageUrlsRepaired: 0,
    scourEntriesMerged: 0,
    zhihuIdeasRemoved: 0,
    zhihuPromotionsRemoved: 0
  };
}

function addToReport(report: ContentMaintenanceReport, result: SourceMaintenanceResult): void {
  report.taxonomyEntriesRemoved += result.taxonomyEntriesRemoved;
  report.homepageUrlsRepaired += result.homepageUrlsRepaired;
  report.scourEntriesMerged += result.scourEntriesMerged;
  report.zhihuIdeasRemoved += result.zhihuIdeasRemoved;
  report.zhihuPromotionsRemoved += result.zhihuPromotionsRemoved;
}

function requiresMaintenance(source: Source): boolean {
  const connectorId = source.connectorId ?? source.kind;
  return connectorId === "generic" || connectorId === "rss" || source.kind === "zhihu_follow";
}
