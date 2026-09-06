import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { parseOpml } from "../src/main/opml";
import { SourceService } from "../src/main/source-service";
import { assertPublicUrl, isTrustedLoopbackFeedUrl } from "../src/shared/url";

const SAMPLE_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><body>
  <outline text="Research"><outline title="ML"><outline text="Example Feed" type="rss" xmlUrl="https://example.com/feed.xml" /></outline></outline>
  <outline text="Local"><outline text="Local Feed" xmlUrl="http://127.0.0.1:1200/example/feed" /></outline>
  <outline text="No URL" />
</body></opml>`;

describe("OPML subscriptions", () => {
  it("rolls back imported subscriptions when persistence fails instead of counting the failure as a skipped outline", () => {
    const database = new ReadingDatabase(":memory:");
    const sync = { syncSource: vi.fn().mockResolvedValue(undefined) };
    const service = new SourceService(database, undefined as never, sync as never, undefined as never);
    const original = database.createSource.bind(database);
    vi.spyOn(database, "createSource").mockImplementation((input) => {
      const source = original(input);
      if (input.url.includes("127.0.0.1")) throw new Error("fixture disk failure");
      return source;
    });
    try {
      expect(() => service.importOpml(SAMPLE_OPML)).toThrow("fixture disk failure");
      expect(database.listSources()).toEqual([]);
      expect(sync.syncSource).not.toHaveBeenCalled();
      vi.mocked(database.createSource).mockImplementation(original);
      expect(service.importOpml(SAMPLE_OPML)).toEqual({ imported: 2, existing: 0, skipped: 0 });
    } finally { database.close(); }
  });

  it("skips an invalid outline without suppressing a later valid outline for the same URL", () => {
    const database = new ReadingDatabase(":memory:");
    const service = new SourceService(database, undefined as never, { syncSource: vi.fn().mockResolvedValue(undefined) } as never, undefined as never);
    const input = `<opml version="2.0"><body>
      <outline text="${"x".repeat(121)}" xmlUrl="https://example.com/feed.xml" />
      <outline text="Valid title" xmlUrl="https://example.com/feed.xml" />
      <outline text="Private" xmlUrl="https://192.168.1.2/feed.xml" />
    </body></opml>`;
    try {
      expect(service.importOpml(input)).toEqual({ imported: 1, existing: 0, skipped: 2 });
      expect(database.listSources()).toMatchObject([{ title: "Valid title" }]);
    } finally { database.close(); }
  });

  it("publishes one complete batch before starting any initial sync", async () => {
    const database = new ReadingDatabase(":memory:");
    const notifications: number[] = [];
    const unsubscribe = database.onLibraryChanged(() => notifications.push(database.listSources().length));
    const syncObservations: number[] = [];
    const sync = { syncSource: vi.fn().mockImplementation(async () => {
      syncObservations.push(database.listSources().length);
    }) };
    const service = new SourceService(database, undefined as never, sync as never, undefined as never);
    try {
      expect(service.importOpml(SAMPLE_OPML)).toEqual({ imported: 2, existing: 0, skipped: 0 });
      expect(notifications).toEqual([2]);
      expect(sync.syncSource).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(sync.syncSource).toHaveBeenCalledTimes(2));
      expect(syncObservations).toEqual([2, 2]);
    } finally { unsubscribe(); database.close(); }
  });

  it("parses feed leaves and keeps nested folder labels", () => {
    expect(parseOpml(SAMPLE_OPML)).toEqual([
      { url: "https://example.com/feed.xml", title: "Example Feed", category: "Research / ML" },
      { url: "http://127.0.0.1:1200/example/feed", title: "Local Feed", category: "Local" }
    ]);
    expect(() => parseOpml("<html><body>not opml</body></html>")).toThrow("有效的 OPML");
  });

  it("imports valid feeds once and marks only an explicit loopback feed as trusted", () => {
    const database = new ReadingDatabase(":memory:");
    const sync = { syncSource: vi.fn().mockResolvedValue(undefined) };
    const service = new SourceService(database, undefined as never, sync as never, undefined as never);

    expect(service.importOpml(SAMPLE_OPML)).toEqual({ imported: 2, existing: 0, skipped: 0 });
    expect(database.listSources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://example.com/feed.xml", category: "Research / ML", config: {} }),
      expect.objectContaining({ url: "http://127.0.0.1:1200/example/feed", category: "Local", config: { allowTrustedLoopbackFeed: true } })
    ]));
    expect(service.importOpml(SAMPLE_OPML)).toEqual({ imported: 0, existing: 2, skipped: 0 });
    database.close();
  });

  it("recognizes IPv4 and IPv6 loopback only for the explicit local-feed path", () => {
    expect(isTrustedLoopbackFeedUrl("http://127.0.0.1:1200/feed")).toBe(true);
    expect(isTrustedLoopbackFeedUrl("http://[::1]:1200/feed")).toBe(true);
    expect(() => assertPublicUrl("http://[::1]:1200/feed")).toThrow("本机或私有网络");
  });

  it("deduplicates an OPML URL against an existing subscription after canonicalization", () => {
    const database = new ReadingDatabase(":memory:");
    database.createSource({
      url: "https://example.com/feed.xml?utm_source=old-import",
      title: "Existing feed",
      kind: "rss",
      pollingEnabled: true
    });
    const service = new SourceService(database, undefined as never, { syncSource: vi.fn().mockResolvedValue(undefined) } as never, undefined as never);

    expect(service.importOpml(SAMPLE_OPML)).toEqual({ imported: 1, existing: 1, skipped: 0 });
    database.close();
  });
});
