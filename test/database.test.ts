import { describe, expect, it } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import type { Entry } from "../src/shared/types";

function entry(sourceId: string, title = "测试文章", options: Partial<Entry> = {}): Entry {
  return {
    id: crypto.randomUUID(),
    sourceId,
    canonicalUrl: "https://example.com/article",
    url: "https://example.com/article?utm_source=feed",
    title,
    contentHash: "hash",
    read: false,
    favorite: false,
    createdAt: Date.now(),
    ...options
  };
}

describe("ReadingDatabase", () => {
  it("deduplicates canonical URLs without resetting read state", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    db.saveEntries([entry(source.id)]);
    const initial = db.listEntries()[0];
    db.markRead(initial.id, true);
    db.saveEntries([entry(source.id, "更新后的标题")]);
    expect(db.listEntries()).toHaveLength(1);
    expect(db.listEntries()[0]).toMatchObject({ title: "更新后的标题", read: true });
    db.close();
  });

  it("does not persist transient Feed HTML with an entry", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    db.saveEntries([{ ...entry(source.id), feedContentHtml: "<p>只可在内存中使用的 Feed 正文</p>" }]);

    expect(db.listEntries()[0]).not.toHaveProperty("feedContentHtml");
    db.close();
  });

  it("removes only empty legacy navigation cards from a refreshed Feed source", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://news.example/", title: "News", kind: "rss", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "News", { canonicalUrl: source.url, url: source.url }),
      entry(source.id, "GitHub", { canonicalUrl: "https://github.com/example", url: "https://github.com/example" }),
      entry(source.id, "Undated real post", { canonicalUrl: "https://news.example/posts/real", url: "https://news.example/posts/real" })
    ]);

    expect(db.deleteNonContentFeedNavigationEntries(source)).toBe(2);
    expect(db.listEntries(source.id).map((item) => item.title)).toEqual(["Undated real post"]);
    db.close();
  });

  it("removes a source homepage card with a site description only after the source declares a Feed", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://news.example/", title: "News", kind: "generic", pollingEnabled: true });
    db.saveEntries([entry(source.id, "News | News", {
      canonicalUrl: source.url,
      url: source.url,
      summary: "A site description rather than an individual article."
    })]);

    expect(db.deleteNonContentFeedNavigationEntries(source)).toBe(0);
    expect(db.deleteNonContentFeedNavigationEntries(source, true)).toBe(1);
    db.close();
  });

  it("removes only the current source origin when pruning a shared Feed navigation card", () => {
    const db = new ReadingDatabase(":memory:");
    const first = db.createSource({ url: "https://news.example/", title: "News", kind: "rss", pollingEnabled: true });
    const second = db.createSource({ url: "https://mirror.example/feed", title: "Mirror", kind: "rss", pollingEnabled: true });
    const sharedUrl = "https://news.example/";
    db.saveEntries([entry(first.id, "News", { canonicalUrl: sharedUrl, url: sharedUrl })]);
    db.saveEntries([entry(second.id, "News", { canonicalUrl: sharedUrl, url: sharedUrl })]);

    expect(db.deleteNonContentFeedNavigationEntries(first)).toBe(1);
    expect(db.listEntries(first.id)).toEqual([]);
    expect(db.listEntries(second.id)).toHaveLength(1);
    expect(db.listEntries(second.id)[0]).toMatchObject({ sourceId: second.id, canonicalUrl: sharedUrl });
    db.close();
  });

  it("removes legacy Zhihu ideas while retaining answers from the authorised Follow source", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://www.zhihu.com/follow", title: "知乎关注动态", kind: "zhihu_follow", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "旧版想法", { canonicalUrl: "https://www.zhihu.com/pin/123", url: "https://www.zhihu.com/pin/123" }),
      entry(source.id, "已发布回答", { canonicalUrl: "https://www.zhihu.com/question/1/answer/2", url: "https://www.zhihu.com/question/1/answer/2" })
    ]);

    expect(db.deleteUnsupportedZhihuFollowEntries(source.id)).toBe(1);
    expect(db.listEntries(source.id).map((item) => item.title)).toEqual(["已发布回答"]);
    db.close();
  });

  it("removes legacy sponsored Zhihu Follow cards while retaining authored posts", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://www.zhihu.com/follow", title: "知乎关注动态", kind: "zhihu_follow", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "推广活动", { canonicalUrl: "https://zhuanlan.zhihu.com/p/1?spu=biz%3D0", url: "https://zhuanlan.zhihu.com/p/1?spu=biz%3D0" }),
      entry(source.id, "作者专栏", { canonicalUrl: "https://zhuanlan.zhihu.com/p/2", url: "https://zhuanlan.zhihu.com/p/2" })
    ]);

    expect(db.deletePromotedZhihuFollowEntries(source.id)).toBe(1);
    expect(db.listEntries(source.id).map((item) => item.title)).toEqual(["作者专栏"]);
    db.close();
  });

  it("pauses a generic source for review after three empty extractions", () => {
    const db = new ReadingDatabase(":memory:");
    let source = db.createSource({ url: "https://example.com/list", title: "Example", kind: "generic", pollingEnabled: true });
    source = db.markSuccess(source, { empty: true });
    source = db.markSuccess(source, { empty: true });
    source = db.markSuccess(source, { empty: true });
    expect(source.status).toBe("needs_review");
    expect(source.nextCheckAt).toBeUndefined();
    db.close();
  });

  it("keeps a failed source eligible for its scheduled retry", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/retry", title: "Example", kind: "rss", pollingEnabled: true });
    const failed = db.markFailure(source, "network failed");
    expect(failed.status).toBe("error");
    expect(db.listDueSources((failed.nextCheckAt ?? 0) + 1).map((item) => item.id)).toContain(source.id);
    db.close();
  });

  it("orders the timeline by newest timestamp even when a newer entry is already read", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/chronological", title: "Example", kind: "rss", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "较早文章", { canonicalUrl: "https://example.com/older", url: "https://example.com/older", publishedAt: 1_000, createdAt: 1_000 }),
      entry(source.id, "最新文章", { canonicalUrl: "https://example.com/newer", url: "https://example.com/newer", publishedAt: 2_000, createdAt: 2_000 })
    ]);
    const newest = db.listEntries()[0];
    db.markRead(newest.id, true);
    expect(db.listEntries().map((item) => item.title)).toEqual(["最新文章", "较早文章"]);
    db.close();
  });

  it("returns navigation counts without loading article bodies", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/counts", title: "Counts", kind: "rss", pollingEnabled: true });
    const today = new Date(2026, 7, 18, 10).getTime();
    const yesterday = new Date(2026, 7, 17, 10).getTime();
    db.saveEntries([
      entry(source.id, "今日未读", { canonicalUrl: "https://example.com/counts/today", url: "https://example.com/counts/today", publishedAt: today }),
      entry(source.id, "昨日收藏", { canonicalUrl: "https://example.com/counts/yesterday", url: "https://example.com/counts/yesterday", publishedAt: yesterday })
    ]);
    const saved = db.listEntries();
    const favourite = saved.find((item) => item.title === "昨日收藏");
    db.markRead(favourite!.id, true);
    db.markFavorite(favourite!.id, true);

    expect(db.getLibraryCounts(new Date(2026, 7, 18, 16).getTime())).toEqual({ unread: 1, favorite: 1, today: 1 });
    db.close();
  });

  it("keeps newly collected entries without a publication time below genuinely dated entries", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/timeline", title: "Example", kind: "rss", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "真实发布时间", { canonicalUrl: "https://example.com/dated", url: "https://example.com/dated", publishedAt: 1_700_000_000_000, createdAt: 1_700_000_000_000 }),
      entry(source.id, "刚同步但未知时间", { canonicalUrl: "https://example.com/unknown", url: "https://example.com/unknown", createdAt: 1_800_000_000_000 })
    ]);
    expect(db.listEntries().map((item) => item.title)).toEqual(["真实发布时间", "刚同步但未知时间"]);
    db.close();
  });

  it("filters entries by source and deletes a source with its collected entries", () => {
    const db = new ReadingDatabase(":memory:");
    const first = db.createSource({ url: "https://example.com/one", title: "One", kind: "rss", pollingEnabled: true });
    const second = db.createSource({ url: "https://example.com/two", title: "Two", kind: "rss", pollingEnabled: true });
    db.saveEntries([
      entry(first.id, "来源一", { canonicalUrl: "https://example.com/entry-one", url: "https://example.com/entry-one" }),
      entry(second.id, "来源二", { canonicalUrl: "https://example.com/entry-two", url: "https://example.com/entry-two" })
    ]);
    expect(db.listEntries(first.id).map((item) => item.title)).toEqual(["来源一"]);
    db.deleteSource(first.id);
    expect(db.getSource(first.id)).toBeUndefined();
    expect(db.listEntries(first.id)).toEqual([]);
    expect(db.listEntries().map((item) => item.title)).toEqual(["来源二"]);
    db.close();
  });

  it("filters the timeline by publication time and falls back to collection time", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/range", title: "Range", kind: "rss", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "范围前", { canonicalUrl: "https://example.com/range/before", url: "https://example.com/range/before", publishedAt: 999, createdAt: 999 }),
      entry(source.id, "范围内发布时间", { canonicalUrl: "https://example.com/range/published", url: "https://example.com/range/published", publishedAt: 1_500, createdAt: 10 }),
      entry(source.id, "范围内收集时间", { canonicalUrl: "https://example.com/range/observed", url: "https://example.com/range/observed", observedAt: 1_600, createdAt: 10 }),
      entry(source.id, "范围结束边界", { canonicalUrl: "https://example.com/range/end", url: "https://example.com/range/end", publishedAt: 2_000, createdAt: 2_000 })
    ]);

    expect(db.listEntries({ sourceId: source.id, startAt: 1_000, endAt: 2_000 }).map((item) => item.title))
      .toEqual(["范围内发布时间", "范围内收集时间"]);
    expect(db.listEntries({ startAt: 2_000, endAt: 1_000 })).toEqual([]);
    db.close();
  });

  it("fills a missing publication time when an existing source is replayed", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/replay", title: "Replay", kind: "generic", pollingEnabled: true });
    const original = entry(source.id, "已收集文章", { canonicalUrl: "https://example.com/replay/article", url: "https://example.com/replay/article", createdAt: 1_900 });
    db.saveEntries([original]);
    db.saveEntries([{ ...original, id: crypto.randomUUID(), publishedAt: 1_700 }]);

    expect(db.listEntries(source.id)[0]).toMatchObject({ publishedAt: 1_700 });
    db.close();
  });

  it("persists a connector metadata replay revision", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/metadata", title: "Metadata", kind: "rss", pollingEnabled: true });

    const updated = db.updateMetadataRevision(source.id, 1);

    expect(updated.metadataRevision).toBe(1);
    expect(db.getSource(source.id)?.metadataRevision).toBe(1);
    db.close();
  });

  it("persists editable source metadata and schedules the selected refresh cadence", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Old title", kind: "rss", pollingEnabled: true });

    const updated = db.updateSourceSettings(source.id, {
      title: "Renamed source",
      kind: "generic",
      pollingEnabled: true,
      refreshIntervalMinutes: 120
    });

    expect(updated).toMatchObject({ title: "Renamed source", kind: "generic", connectorId: "generic", pollingEnabled: true, refreshIntervalMinutes: 120 });
    expect(updated.nextCheckAt).toBeGreaterThan(Date.now() + 100 * 60_000);
    expect(updated.nextCheckAt).toBeLessThan(Date.now() + 135 * 60_000);
    expect(db.getSubscriptionForSource(source.id)).toMatchObject({ connectorId: "generic", accountId: undefined });
    db.close();
  });

  it("persists a local-only source folder without changing the connector", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", category: "  机器学习  ", kind: "rss", pollingEnabled: true });

    const updated = db.updateSourceSettings(source.id, {
      title: "Example",
      category: "研究笔记",
      kind: "rss",
      pollingEnabled: true
    });

    expect(source.category).toBe("机器学习");
    expect(updated).toMatchObject({ category: "研究笔记", connectorId: "rss", kind: "rss" });
    expect(db.getSource(source.id)?.category).toBe("研究笔记");
    db.close();
  });

  it("removes a dismissed card and keeps it hidden when its feed returns it again", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/dismissed", title: "Example", kind: "rss", pollingEnabled: true });
    const record = entry(source.id, "不想再看到", { canonicalUrl: "https://example.com/dismissed-entry", canonicalIdentity: "article:dismissed" });
    db.saveEntries([record]);
    const stored = db.listEntries()[0];
    db.dismissEntry(stored.id);
    expect(db.listEntries()).toEqual([]);
    db.saveEntries([{ ...record, id: crypto.randomUUID(), createdAt: Date.now() + 1 }]);
    expect(db.listEntries()).toEqual([]);
    db.close();
  });

  it("removes taxonomy cards from an older generic extraction and resets cards on rule correction", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "http://heavensheep.xyz/", title: "Heaven Sheep", kind: "generic", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "paper", { canonicalUrl: "http://heavensheep.xyz/tags/paper", url: "http://heavensheep.xyz/tags/paper" }),
      entry(source.id, "真实文章", { canonicalUrl: "http://heavensheep.xyz/posts/real", url: "http://heavensheep.xyz/posts/real" })
    ]);
    expect(db.deleteTaxonomyEntries(source.id)).toBe(1);
    expect(db.listEntries(source.id).map((item) => item.title)).toEqual(["真实文章"]);
    db.updateRule(source.id, { version: 1, itemRootSelector: "article.post-card" });
    expect(db.listEntries(source.id)).toEqual([]);
    db.close();
  });

  it("persists an automatic rule repair without discarding entries or read state", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({
      url: "https://accelazh.github.io/",
      title: "Accela",
      kind: "generic",
      pollingEnabled: true,
      extractionRule: { version: 1, itemRootSelector: 'a[href*="/openstack/"]' }
    });
    db.saveEntries([entry(source.id, "Existing post")]);
    const existing = db.listEntries(source.id)[0];
    db.markRead(existing.id, true);

    const repaired = db.replaceAutomaticRule(source.id, { version: 1, itemRootSelector: "li" });

    expect(repaired.extractionRule?.itemRootSelector).toBe("li");
    expect(db.listEntries(source.id)).toHaveLength(1);
    expect(db.listEntries(source.id)[0]?.read).toBe(true);
    db.close();
  });

  it("keeps multiple source origins for a single content item", () => {
    const db = new ReadingDatabase(":memory:");
    const rss = db.createSource({ url: "https://example.com/rss", title: "RSS", kind: "rss", pollingEnabled: true });
    const academic = db.createSource({ url: "https://academic.local/author/a", title: "Author", kind: "academic", connectorId: "academic", pollingEnabled: true });
    db.saveEntries([entry(rss.id, "论文", { canonicalUrl: "https://doi.org/10.1000/example", canonicalIdentity: "doi:10.1000/example", providerId: "rss" })]);
    db.saveEntries([entry(academic.id, "论文（索引更新）", { canonicalUrl: "https://doi.org/10.1000/example", canonicalIdentity: "doi:10.1000/example", providerId: "academic", providerLabel: "OpenAlex" })]);
    const saved = db.listEntries();
    expect(saved).toHaveLength(1);
    expect(saved[0].origins?.map((origin) => origin.sourceId)).toEqual(expect.arrayContaining([rss.id, academic.id]));
    expect(saved[0].origins?.some((origin) => origin.providerLabel === "OpenAlex")).toBe(true);
    db.deleteSource(rss.id);
    expect(db.listEntries()).toHaveLength(1);
    expect(db.listEntries()[0].sourceId).toBe(academic.id);
    db.close();
  });

  it("creates a compatibility subscription and persists checkpoints separately from source metadata", () => {
    const db = new ReadingDatabase(":memory:");
    const account = db.saveAccount({ connectorId: "x", displayName: "X", scopes: [], status: "active" });
    const source = db.createSource({ url: "https://api.x.com/2/users/me/following", title: "X", kind: "x", connectorId: "x", accountId: account.id, pollingEnabled: true });
    const subscription = db.getSubscriptionForSource(source.id);
    expect(subscription).toMatchObject({ sourceId: source.id, connectorId: "x", accountId: account.id });
    db.saveCheckpoint(subscription!.id, { sinceId: "123", data: { sinceByUser: { user: "123" } } });
    expect(db.getCheckpoint(subscription!.id)).toMatchObject({ sinceId: "123", data: { sinceByUser: { user: "123" } } });
    db.close();
  });
});
