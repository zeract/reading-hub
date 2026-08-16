import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/main/feed";

describe("feed parser", () => {
  it("normalizes Atom/RSS fields into reader entries", async () => {
    const feed = await parseFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>测试订阅</title><item><title>第一条</title><link>/first</link><pubDate>Thu, 14 Aug 2026 08:00:00 GMT</pubDate><description>第一条摘要</description></item></channel></rss>`,
      "https://example.com/feed.xml"
    );
    expect(feed.title).toBe("测试订阅");
    expect(feed.entries).toEqual([expect.objectContaining({
      title: "第一条",
      url: "https://example.com/first",
      summary: "第一条摘要",
      publishedAt: Date.UTC(2026, 7, 14)
    })]);
  });

  it("accepts JSON Feed", async () => {
    const feed = await parseFeed(
      JSON.stringify({ version: "https://jsonfeed.org/version/1", title: "JSON Feed", items: [{ id: "x", url: "/post", title: "JSON 条目", summary: "摘要" }] }),
      "https://example.com/feed.json"
    );
    expect(feed.entries[0]).toMatchObject({ title: "JSON 条目", url: "https://example.com/post" });
  });
});
