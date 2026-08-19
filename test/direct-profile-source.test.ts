import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

function serviceFor(database: ReadingDatabase) {
  const probe = { probe: vi.fn() };
  const sync = { savePreview: vi.fn() };
  return new SourceService(database, probe as never, sync as never, undefined as never);
}

describe("direct platform profile sources", () => {
  it("creates an X author target from a profile URL without an API account", () => {
    const database = new ReadingDatabase(":memory:");
    const service = serviceFor(database);
    const source = service.createXProfileSource({ url: "https://twitter.com/Example_User/", title: "Example posts" });

    expect(source).toMatchObject({
      url: "https://x.com/Example_User",
      title: "Example posts",
      category: "平台动态",
      kind: "x",
      connectorId: "x",
      accountId: undefined,
      config: { mode: "public-profile", username: "Example_User", transport: "x-public-embed" }
    });
    expect(database.getSubscriptionForSource(source.id)).toMatchObject({ connectorId: "x", accountId: undefined, config: { mode: "public-profile", username: "Example_User", transport: "x-public-embed" } });
    expect(service.createXProfileSource({ url: "https://x.com/Example_User" }).id).toBe(source.id);
    database.close();
  });

  it("switches a failed OAuth profile subscription to the public transport", () => {
    const database = new ReadingDatabase(":memory:");
    const account = database.saveAccount({
      connectorId: "x", displayName: "X · @reader", subjectId: "reader", keychainAccount: "x:reader", scopes: ["tweet.read"], status: "active"
    });
    const service = serviceFor(database);
    const old = database.createSource({
      url: "https://x.com/example", title: "Old X", kind: "x", connectorId: "x", accountId: account.id,
      config: { mode: "profile", username: "example" }, pollingEnabled: true, status: "error"
    });
    database.saveCheckpoint(old.id, { sinceId: "111", data: { old: true } });
    const source = service.createXProfileSource({ url: "https://x.com/example" });
    expect(source).toMatchObject({ id: old.id, accountId: undefined, status: "active", config: { mode: "public-profile", username: "example", transport: "x-public-embed" } });
    expect(database.getSubscriptionForSource(source.id)).toMatchObject({ accountId: undefined, config: { mode: "public-profile", username: "example" } });
    expect(database.getCheckpoint(source.id)).toBeUndefined();
    database.close();
  });

  it("requires a profile URL rather than a status or RSSHub route", () => {
    const database = new ReadingDatabase(":memory:");
    const service = serviceFor(database);
    expect(() => service.createXProfileSource({ url: "https://x.com/example/status/42" })).toThrow("单个 X 博主主页");
    expect(() => service.createXProfileSource({ url: "https://rsshub.example/twitter/user/example" })).toThrow("x.com 或 twitter.com");
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
