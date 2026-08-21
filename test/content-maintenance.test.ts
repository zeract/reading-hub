import { describe, expect, it } from "vitest";
import { ContentMaintenance, SOURCE_CONTENT_MAINTENANCE_REVISION } from "../src/main/content-maintenance";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager } from "../src/main/sync-manager";
import type { ConnectorAdapter, Entry, RawEntry, Source } from "../src/shared/types";

function entry(sourceId: string, title: string, options: Partial<Entry>): Entry {
  return {
    id: crypto.randomUUID(),
    sourceId,
    canonicalUrl: "https://example.com/article",
    url: "https://example.com/article",
    title,
    contentHash: crypto.randomUUID(),
    read: false,
    favorite: false,
    createdAt: Date.now(),
    ...options
  };
}

describe("ContentMaintenance", () => {
  it("repairs historical source data once at startup and records a source-scoped revision", () => {
    const database = new ReadingDatabase(":memory:");
    const generic = database.createSource({ url: "http://heavensheep.xyz/", title: "Generic", kind: "generic", pollingEnabled: true });
    const rss = database.createSource({ url: "https://scour.ing/feed", title: "Scour", kind: "rss", pollingEnabled: true });
    const zhihu = database.createSource({ url: "https://www.zhihu.com/follow", title: "Zhihu", kind: "zhihu_follow", pollingEnabled: true });
    const scourUrl = "https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost";

    database.saveEntries([
      entry(generic.id, "分类卡片", { canonicalUrl: "http://heavensheep.xyz/tags/paper", url: "http://heavensheep.xyz/tags/paper" }),
      entry(generic.id, "旧首页链接", {
        canonicalUrl: "http://heavensheep.xyz/?legacy=1",
        url: generic.url,
        canonicalIdentity: "http://heavensheep.xyz/?p=577"
      }),
      entry(rss.id, "Scour post", {
        canonicalUrl: `${scourUrl}?as=first`,
        url: `${scourUrl}?as=first`,
        canonicalIdentity: `${scourUrl}?as=first`
      }),
      entry(rss.id, "Scour post", {
        canonicalUrl: `${scourUrl}?ct=second`,
        url: `${scourUrl}?ct=second`,
        canonicalIdentity: `${scourUrl}?ct=second`
      }),
      entry(zhihu.id, "旧想法", { canonicalUrl: "https://www.zhihu.com/pin/1", url: "https://www.zhihu.com/pin/1" }),
      entry(zhihu.id, "推广内容", { canonicalUrl: "https://zhuanlan.zhihu.com/p/1?spu=biz%3D0", url: "https://zhuanlan.zhihu.com/p/1?spu=biz%3D0" }),
      entry(zhihu.id, "保留的文章", { canonicalUrl: "https://zhuanlan.zhihu.com/p/2", url: "https://zhuanlan.zhihu.com/p/2" })
    ]);

    const maintenance = new ContentMaintenance(database);
    const report = maintenance.runStartupMaintenance();

    expect(report).toMatchObject({
      inspectedSources: 3,
      maintainedSources: 3,
      skippedSources: 0,
      taxonomyEntriesRemoved: 1,
      homepageUrlsRepaired: 1,
      scourEntriesMerged: 2,
      zhihuIdeasRemoved: 1,
      zhihuPromotionsRemoved: 1,
      failures: []
    });
    expect(database.listEntries(generic.id).map((item) => item.canonicalUrl)).toEqual(["http://heavensheep.xyz/?p=577"]);
    expect(database.listEntries(rss.id)).toHaveLength(1);
    expect(database.listEntries(zhihu.id).map((item) => item.title)).toEqual(["保留的文章"]);
    for (const source of [generic, rss, zhihu]) {
      expect(database.getSourceMaintenanceRevision(source.id)).toBe(SOURCE_CONTENT_MAINTENANCE_REVISION);
    }

    expect(maintenance.runStartupMaintenance()).toMatchObject({
      inspectedSources: 3,
      maintainedSources: 0,
      skippedSources: 3,
      taxonomyEntriesRemoved: 0,
      homepageUrlsRepaired: 0,
      scourEntriesMerged: 0,
      zhihuIdeasRemoved: 0,
      zhihuPromotionsRemoved: 0,
      failures: []
    });

    const newlyAdded = database.createSource({ url: "https://new.example.com/", title: "New source", kind: "generic", pollingEnabled: true });
    expect(maintenance.prepareForSync(newlyAdded)).toMatchObject({ sourceId: newlyAdded.id, skipped: false });
    expect(database.getSourceMaintenanceRevision(newlyAdded.id)).toBeUndefined();
    expect(maintenance.afterSuccessfulSync(newlyAdded)).toMatchObject({ sourceId: newlyAdded.id, skipped: false });
    expect(database.getSourceMaintenanceRevision(newlyAdded.id)).toBe(SOURCE_CONTENT_MAINTENANCE_REVISION);
    expect(maintenance.prepareForSync(newlyAdded)).toMatchObject({ sourceId: newlyAdded.id, skipped: true });
    database.updateSourceSettings(newlyAdded.id, { title: "New source", kind: "rss", pollingEnabled: true });
    expect(database.getSourceMaintenanceRevision(newlyAdded.id)).toBeUndefined();
    database.close();
  });

  it("uses the sync lifecycle only until a historical source revision is complete", async () => {
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({ url: "https://example.com/", title: "Generic", kind: "generic", pollingEnabled: true });
    database.saveEntries([
      entry(source.id, "旧分类卡片", { canonicalUrl: "https://example.com/tags/old", url: "https://example.com/tags/old" })
    ]);
    const registry = new ConnectorRegistry();
    registry.register(emptyGenericAdapter());
    const maintenance = new ContentMaintenance(database);

    await new SyncManager(database, registry, undefined, maintenance).syncSource(source.id);

    expect(database.listEntries(source.id)).toEqual([]);
    expect(database.getSourceMaintenanceRevision(source.id)).toBe(SOURCE_CONTENT_MAINTENANCE_REVISION);
    expect(maintenance.prepareForSync(source)).toMatchObject({ skipped: true });
    database.close();
  });
});

function emptyGenericAdapter(): ConnectorAdapter {
  return {
    manifest: { id: "generic", version: 1, displayName: "Generic", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
    async sync() {
      return { entries: [], emptyIsHealthy: true };
    },
    normalize(item: RawEntry, source: Source): Entry {
      return entry(source.id, item.title, { ...item, canonicalUrl: item.url, url: item.url });
    }
  };
}
