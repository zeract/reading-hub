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
  it("pages a large source without a 200-entry ceiling, skips, or duplicate timestamp ties", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const allEntries = Array.from({ length: 205 }, (_, index) => entry(source.id, `文章 ${index}`, {
      id: `paged-entry-${String(index).padStart(3, "0")}`,
      canonicalUrl: `https://example.com/paged/${index}`,
      url: `https://example.com/paged/${index}`,
      contentHash: `paged-hash-${index}`,
      // The first 150 intentionally share every timestamp, forcing the
      // keyset cursor to use the entry id as its stable final tie-breaker.
      publishedAt: index < 150 ? 1_700_000_000_000 : undefined,
      observedAt: index < 150 ? 1_600_000_000_000 : 1_500_000_000_000,
      createdAt: 1_400_000_000_000
    }));
    db.saveEntries(allEntries);

    const first = db.listEntryPage({ sourceId: source.id, pageSize: 100 });
    const second = db.listEntryPage({ sourceId: source.id, pageSize: 100, cursor: first.nextCursor! });
    const third = db.listEntryPage({ sourceId: source.id, pageSize: 100, cursor: second.nextCursor! });
    const collected = [...first.entries, ...second.entries, ...third.entries];

    expect(first.entries).toHaveLength(100);
    expect(second.entries).toHaveLength(100);
    expect(third.entries).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
    expect(collected.map((item) => item.id)).toHaveLength(205);
    expect(new Set(collected.map((item) => item.id))).toHaveLength(205);
    expect(new Set(collected.map((item) => item.id))).toEqual(new Set(allEntries.map((item) => item.id)));
    db.close();
  });

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

  it("stores only validated public source icon metadata", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });

    expect(db.updateSourceIcon(source.id, "https://cdn.example.com/logo.png")).toMatchObject({ iconUrl: "https://cdn.example.com/logo.png" });
    expect(db.updateSourceIcon(source.id, "http://127.0.0.1/logo.png")).toMatchObject({ iconUrl: "https://cdn.example.com/logo.png" });
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

  it("merges legacy Scour redirect variants without losing read or favorite state", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://scour.ing/feed", title: "Scour", kind: "rss", pollingEnabled: true });
    const base = "https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost";
    db.saveEntries([
      entry(source.id, "Post", { canonicalUrl: `${base}?as=first`, url: `${base}?as=first`, canonicalIdentity: `${base}?as=first`, summary: "Short" }),
      entry(source.id, "Post", { canonicalUrl: `${base}?ct=second`, url: `${base}?ct=second`, canonicalIdentity: `${base}?ct=second`, summary: "A longer summary retained after merge." })
    ]);
    const older = db.listEntries(source.id).find((item) => item.canonicalUrl.includes("as=first"))!;
    db.markRead(older.id, true);
    db.markFavorite(older.id, true);

    expect(db.repairScourRedirectEntries(source.id)).toBe(2);
    expect(db.listEntries(source.id)).toEqual([expect.objectContaining({
      canonicalUrl: base,
      canonicalIdentity: base,
      read: true,
      favorite: true,
      summary: "A longer summary retained after merge."
    })]);
    db.close();
  });

  it("retains another source origin when a Scour redirect variant merges into an existing card", () => {
    const db = new ReadingDatabase(":memory:");
    const scour = db.createSource({ url: "https://scour.ing/feed", title: "Scour", kind: "rss", pollingEnabled: true });
    const direct = db.createSource({ url: "https://example.com/feed", title: "Direct", kind: "rss", pollingEnabled: true });
    const base = "https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost";
    db.saveEntries([
      entry(scour.id, "Post", { canonicalUrl: `${base}?as=first`, url: `${base}?as=first`, canonicalIdentity: `${base}?as=first` }),
      entry(direct.id, "Post", { canonicalUrl: base, url: base, canonicalIdentity: base })
    ]);

    db.repairScourRedirectEntries(scour.id);
    expect(db.listEntries()).toEqual([expect.objectContaining({
      canonicalUrl: base,
      origins: expect.arrayContaining([
        expect.objectContaining({ sourceId: scour.id }),
        expect.objectContaining({ sourceId: direct.id })
      ])
    })]);
    db.close();
  });

  it("repairs legacy generic cards whose URLs were saved as source-home variants", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "http://heavensheep.xyz/", title: "Heaven Sheep", kind: "generic", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "Post one", { canonicalUrl: "http://heavensheep.xyz/?legacy=1", url: source.url, canonicalIdentity: "http://heavensheep.xyz/?p=577" }),
      entry(source.id, "Post two", { canonicalUrl: "http://heavensheep.xyz/?legacy=2", url: source.url, canonicalIdentity: "http://heavensheep.xyz/?p=576" })
    ]);

    expect(db.repairGenericHomepageEntryUrls(source)).toBe(2);
    expect(db.listEntries(source.id).map((item) => item.canonicalUrl)).toEqual(expect.arrayContaining([
      "http://heavensheep.xyz/?p=577",
      "http://heavensheep.xyz/?p=576"
    ]));
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

  it("continues retrying after repeated transient failures instead of pausing the source", () => {
    const db = new ReadingDatabase(":memory:");
    let source = db.createSource({ url: "https://example.com/retry-forever", title: "Example", kind: "rss", pollingEnabled: true });
    for (let attempt = 0; attempt < 6; attempt += 1) source = db.markFailure(source, "temporary network failure");

    expect(source).toMatchObject({ status: "error", failureCount: 6, pollingEnabled: true });
    expect(source.nextCheckAt).toBeDefined();
    expect(db.listDueSources((source.nextCheckAt ?? 0) + 1).map((item) => item.id)).toContain(source.id);
    db.close();
  });

  it("recovers only legacy automatic pauses and preserves explicit pauses", () => {
    const db = new ReadingDatabase(":memory:");
    const legacy = db.createSource({ url: "https://example.com/legacy", title: "Legacy", kind: "rss", pollingEnabled: true });
    const explicit = db.createSource({ url: "https://example.com/explicit", title: "Explicit", kind: "rss", pollingEnabled: true });
    db.pauseSource(explicit.id, "user paused");
    // This state can only originate from older app versions, so construct it
    // directly as a migration fixture rather than reintroducing the old API.
    (db as any).db.prepare(`UPDATE sources SET status = 'paused', polling_enabled = 1, next_check_at = NULL, failure_count = 5 WHERE id = ?`).run(legacy.id);

    const now = 1_800_000_000_000;
    expect(db.resumeLegacyAutoPausedSources(now)).toBe(1);
    expect(db.getSource(legacy.id)).toMatchObject({ status: "error", pollingEnabled: true });
    expect(db.getSource(legacy.id)?.nextCheckAt).toBeGreaterThanOrEqual(now);
    expect(db.getSource(legacy.id)?.nextCheckAt).toBeLessThan(now + 15 * 60_000);
    expect(db.getSource(explicit.id)).toMatchObject({ status: "paused", pollingEnabled: false, nextCheckAt: undefined });
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

  it("filters unread and saved timelines before pagination", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/state", title: "State", kind: "rss", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "未读", { canonicalUrl: "https://example.com/state/unread", url: "https://example.com/state/unread" }),
      entry(source.id, "已读收藏", { canonicalUrl: "https://example.com/state/saved", url: "https://example.com/state/saved" })
    ]);
    const saved = db.listEntries({ sourceId: source.id, limit: 10 }).find((item) => item.title === "已读收藏")!;
    db.markRead(saved.id, true);
    db.markFavorite(saved.id, true);

    expect(db.listEntryPage({ read: false }).entries.map((item) => item.title)).toEqual(["未读"]);
    expect(db.listEntryPage({ sourceId: source.id, favorite: true }).entries.map((item) => item.title)).toEqual(["已读收藏"]);
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

  it("preserves a connector identity when only its UI-compatible source settings change", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({
      url: "https://provider.example/feed", title: "Provider", kind: "generic", connectorId: "provider-test", pollingEnabled: true
    });

    const updated = db.updateSourceSettings(source.id, {
      title: "Renamed provider", category: "技术", kind: "generic", pollingEnabled: true, refreshIntervalMinutes: 60
    });

    expect(updated).toMatchObject({ connectorId: "provider-test", kind: "generic", title: "Renamed provider", category: "技术" });
    expect(db.getSubscriptionForSource(source.id)).toMatchObject({ connectorId: "provider-test" });
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

  it("does not remove Scientific Spaces articles that use an archives article URL", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://kexue.fm/", title: "科学空间", kind: "generic", pollingEnabled: true });
    db.saveEntries([
      entry(source.id, "归档页", { canonicalUrl: "https://kexue.fm/archives", url: "https://kexue.fm/archives" }),
      entry(source.id, "真实文章", { canonicalUrl: "https://kexue.fm/archives/11854", url: "https://kexue.fm/archives/11854" })
    ]);

    expect(db.deleteTaxonomyEntries(source.id)).toBe(1);
    expect(db.listEntries(source.id).map((item) => item.canonicalUrl)).toEqual(["https://kexue.fm/archives/11854"]);
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

  it("persists facets per source-origin, exposes source counts, and filters the library safely", () => {
    const db = new ReadingDatabase(":memory:");
    const primary = db.createSource({ url: "https://example.com/feed", title: "Primary", kind: "rss", pollingEnabled: true });
    const mirror = db.createSource({ url: "https://mirror.example/feed", title: "Mirror", kind: "rss", pollingEnabled: true });
    const category = { scheme: "feed:https://example.com:category", key: "machine-learning", label: "机器学习" };
    const tag = { scheme: "feed:https://mirror.example:tag", key: "research", label: "Research" };
    const canonicalUrl = "https://example.com/posts/shared";

    db.saveEntries([
      entry(primary.id, "Shared", { canonicalUrl, url: canonicalUrl, facets: [category] }),
      entry(mirror.id, "Shared", { canonicalUrl, url: canonicalUrl, facets: [tag] })
    ]);

    const stored = db.listEntries()[0]!;
    expect(stored.facets).toEqual(expect.arrayContaining([category, tag]));
    expect(stored.origins?.find((origin) => origin.sourceId === primary.id)?.facets).toEqual([category]);
    expect(stored.origins?.find((origin) => origin.sourceId === mirror.id)?.facets).toEqual([tag]);
    expect(db.listSourceFacets(primary.id)).toEqual([{ ...category, sourceId: primary.id, entryCount: 1 }]);
    expect(db.getSourceCollectionSettings(primary.id)).toEqual({
      scope: { facetSelections: [], history: { mode: "none" } },
      facets: [{ ...category, sourceId: primary.id, entryCount: 1 }]
    });
    expect(db.listEntries({ sourceId: primary.id, facetSelections: [{ scheme: category.scheme, key: category.key }] })).toHaveLength(1);
    expect(db.listEntries({ sourceId: primary.id, facetSelections: [{ scheme: tag.scheme, key: tag.key }] })).toEqual([]);

    // An explicit empty category response updates only this source-origin;
    // the mirror's independently declared tag remains attached to the card.
    db.saveEntries([entry(primary.id, "Shared", { canonicalUrl, url: canonicalUrl, facets: [] })]);
    const afterClear = db.listEntries()[0]!;
    expect(afterClear.facets).toEqual([tag]);
    expect(afterClear.origins?.find((origin) => origin.sourceId === primary.id)?.facets).toEqual([]);
    expect(db.listSourceFacets(primary.id)).toEqual([]);
    expect(db.listSourceFacets(mirror.id)).toEqual([{ ...tag, sourceId: mirror.id, entryCount: 1 }]);
    db.deleteSource(primary.id);
    expect(db.listEntries(mirror.id)[0]?.facets).toEqual([tag]);
    expect(db.listEntries(mirror.id)[0]?.origins).toEqual([expect.objectContaining({ sourceId: mirror.id, facets: [tag] })]);
    db.close();
  });

  it("persists a bounded subscription scope without changing legacy source configuration", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({
      url: "https://example.com/feed",
      title: "Example",
      kind: "rss",
      config: { legacyOption: true },
      pollingEnabled: true
    });
    const selected = { scheme: "feed:https://example.com:category", key: "systems", label: "系统" };

    const subscription = db.updateSubscriptionScope(source.id, {
      facetSelections: [selected, { ...selected }],
      history: { mode: "selected", limit: 100 }
    });

    expect(subscription.scope).toEqual({ facetSelections: [selected], history: { mode: "selected", limit: 100 } });
    expect(db.getSubscriptionForSource(source.id)?.scope).toEqual(subscription.scope);
    expect(db.getSource(source.id)?.config).toEqual({ legacyOption: true });
    expect(() => db.updateSubscriptionScope(source.id, { facetSelections: [], history: { mode: "selected" } }))
      .toThrow("选择分类历史时至少选择一个分类");
    expect(() => db.updateSubscriptionScope(source.id, { facetSelections: [selected], history: { mode: "all" } }))
      .toThrow("不能同时筛选文章分类");
    db.close();
  });

  it("uses a source's saved scope for its normal timeline without deleting retained cards", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const systems = { scheme: "feed:https://example.com:category", key: "systems", label: "Systems" };
    db.saveEntries([
      entry(source.id, "Systems", { canonicalUrl: "https://example.com/systems", url: "https://example.com/systems", facets: [systems] }),
      entry(source.id, "ML", { canonicalUrl: "https://example.com/ml", url: "https://example.com/ml", facets: [{ scheme: systems.scheme, key: "ml", label: "ML" }] })
    ]);
    db.updateSubscriptionScope(source.id, { facetSelections: [systems], history: { mode: "none" } });

    expect(db.listEntries(source.id).map((item) => item.title)).toEqual(["Systems"]);
    const retained = db.listEntries({ sourceId: source.id, facetSelections: [] }).map((item) => item.title);
    expect(retained).toHaveLength(2);
    expect(retained).toEqual(expect.arrayContaining(["ML", "Systems"]));
    db.close();
  });

  it("resets a selected collection scope when the connector kind changes", () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    db.updateSubscriptionScope(source.id, {
      facetSelections: [{ scheme: "feed:https://example.com:category", key: "systems", label: "系统" }],
      history: { mode: "selected", limit: 50 }
    });

    db.updateSourceSettings(source.id, { title: "Example", kind: "generic", pollingEnabled: true });

    expect(db.getSubscriptionForSource(source.id)).toMatchObject({
      connectorId: "generic",
      scope: { facetSelections: [], history: { mode: "none" } }
    });
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
