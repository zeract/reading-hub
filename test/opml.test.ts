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
      expect.objectContaining({ url: "https://example.com/feed.xml", category: "Research / ML", config: undefined }),
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
