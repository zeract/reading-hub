import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

function serviceFor(database: ReadingDatabase, kind: "rss" | "generic" = "rss") {
  const probe = {
    probe: vi.fn().mockResolvedValue({
      kind,
      title: "RSSHub 示例 Feed",
      url: "https://feeds.example.test/twitter/followings/reader",
      confidence: 1,
      preview: [],
      requiresReview: false
    })
  };
  const sync = { savePreview: vi.fn() };
  return { probe, sync, service: new SourceService(database, probe as never, sync as never, undefined as never) };
}

describe("RSSHub subscription sources", () => {
  it("keeps an RSSHub X route on the normal RSS pipeline with local platform metadata", async () => {
    const database = new ReadingDatabase(":memory:");
    const { probe, sync, service } = serviceFor(database);

    const source = await service.createRssHubSource({
      url: "https://feeds.example.test/twitter/followings/reader",
      platform: "x",
      title: "我的 X 关注"
    });

    expect(probe.probe).toHaveBeenCalledWith("https://feeds.example.test/twitter/followings/reader");
    expect(source).toMatchObject({
      title: "我的 X 关注",
      category: "平台动态",
      kind: "rss",
      connectorId: "rss",
      config: { sourceProvider: "rsshub", rsshubPlatform: "x" }
    });
    expect(sync.savePreview).toHaveBeenCalledWith(source, []);
    expect(database.getSubscriptionForSource(source.id)).toMatchObject({
      connectorId: "rss",
      config: { sourceProvider: "rsshub", rsshubPlatform: "x" }
    });
    expect(() => service.updateSettings(source.id, { title: source.title, kind: "generic", pollingEnabled: true }))
      .toThrow("RSSHub 路由固定使用 Feed 连接器");
    database.close();
  });

  it("requires an RSSHub route for the declared platform and a Feed response", async () => {
    const database = new ReadingDatabase(":memory:");
    const { service } = serviceFor(database, "generic");

    await expect(service.createRssHubSource({
      url: "https://feeds.example.test/xiaohongshu/user/abc/notes",
      platform: "xiaohongshu"
    })).rejects.toThrow("没有返回可订阅的 Feed");
    await expect(service.createRssHubSource({
      url: "https://feeds.example.test/not-twitter/reader",
      platform: "x"
    })).rejects.toThrow("/twitter/");
    await expect(service.createRssHubSource({
      url: "http://127.0.0.1:1200/twitter/followings/reader",
      platform: "x"
    })).rejects.toThrow("私有网络");
    database.close();
  });
});
