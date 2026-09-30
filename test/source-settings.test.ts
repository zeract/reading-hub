import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

function serviceFor(database: ReadingDatabase): SourceService {
  return new SourceService(database, undefined as never, { cancelSource: vi.fn() } as never, undefined as never);
}

describe("source settings", () => {
  it("allows public source type changes but protects an authorised connector binding", () => {
    const database = new ReadingDatabase(":memory:");
    const service = serviceFor(database);
    const publicSource = database.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
    const authorisedSource = database.createSource({ url: "https://www.zhihu.com/follow", title: "知乎", kind: "zhihu_follow", connectorId: "zhihu_follow", pollingEnabled: true });

    expect(service.updateSettings(publicSource.id, { title: "Blog", kind: "generic", pollingEnabled: true, refreshIntervalMinutes: 60 }))
      .toMatchObject({ title: "Blog", kind: "generic", connectorId: "generic", refreshIntervalMinutes: 60 });
    expect(() => service.updateSettings(authorisedSource.id, { title: "知乎", kind: "generic", pollingEnabled: true }))
      .toThrow("连接器决定");
    expect(service.updateSettings(authorisedSource.id, { title: "我的知乎", kind: "zhihu_follow", pollingEnabled: false }))
      .toMatchObject({ title: "我的知乎", kind: "zhihu_follow", pollingEnabled: false });
    database.close();
  });
});
