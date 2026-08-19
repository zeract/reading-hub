import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

function serviceFor(database: ReadingDatabase) {
  const probe = { probe: vi.fn() };
  const sync = { savePreview: vi.fn() };
  return new SourceService(database, probe as never, sync as never, undefined as never);
}

describe("direct platform profile sources", () => {
  it("pauses legacy X public-profile sources instead of retrying a robots-blocked transport", () => {
    const database = new ReadingDatabase(":memory:");
    const service = serviceFor(database);
    const source = database.createSource({
      url: "https://x.com/example", title: "X · @example", kind: "x", connectorId: "x",
      config: { mode: "public-profile", username: "example", transport: "x-public-embed" }, pollingEnabled: true
    });
    expect(service.retireUnsupportedXPublicProfileSources()).toBe(1);
    expect(database.getSource(source.id)).toMatchObject({
      status: "paused",
      pollingEnabled: false,
      lastError: expect.stringContaining("已停止刷新")
    });
    expect(service.updateSettings(source.id, {
      title: "X · @example", kind: "x", pollingEnabled: true, refreshIntervalMinutes: 30
    })).toMatchObject({ status: "paused", pollingEnabled: false });
    expect(service.retireUnsupportedXPublicProfileSources()).toBe(0);
    database.close();
  });

  it("creates a dedicated public Xiaohongshu profile source without a feed transport", () => {
    const database = new ReadingDatabase(":memory:");
    const service = serviceFor(database);
    const source = service.createXiaohongshuProfileSource({
      url: "https://www.xiaohongshu.com/user/profile/abcD_1234?xsec_source=pc_user",
      title: "小红书 · 测试博主"
    });
    expect(source).toMatchObject({
      url: "https://www.xiaohongshu.com/user/profile/abcD_1234",
      kind: "xiaohongshu",
      connectorId: "xiaohongshu",
      config: { mode: "profile", profileId: "abcD_1234" }
    });
    expect(() => service.createXiaohongshuProfileSource({ url: "https://www.xiaohongshu.com/explore/abcD_1234" })).toThrow("小红书博主主页");
    database.close();
  });
});
