import { describe, expect, it } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

function serviceFor(database: ReadingDatabase): SourceService {
  return new SourceService(database, undefined as never, undefined as never, undefined as never);
}

describe("source settings", () => {
  it("allows public source type changes but protects an authorised connector binding", () => {
    const database = new ReadingDatabase(":memory:");
    const service = serviceFor(database);
    const publicSource = database.createSource({ url: "https://example.com/feed", title: "Feed", kind: "rss", pollingEnabled: true });
    const authorisedSource = database.createSource({ url: "https://api.x.com/2/users/me", title: "X", kind: "x", connectorId: "x", pollingEnabled: true });

    expect(service.updateSettings(publicSource.id, { title: "Blog", kind: "generic", pollingEnabled: true, refreshIntervalMinutes: 60 }))
      .toMatchObject({ title: "Blog", kind: "generic", connectorId: "generic", refreshIntervalMinutes: 60 });
    expect(() => service.updateSettings(authorisedSource.id, { title: "X", kind: "generic", pollingEnabled: true }))
      .toThrow("连接器决定");
    expect(service.updateSettings(authorisedSource.id, { title: "我的 X", kind: "x", pollingEnabled: false }))
      .toMatchObject({ title: "我的 X", kind: "x", pollingEnabled: false });
    database.close();
  });
});
