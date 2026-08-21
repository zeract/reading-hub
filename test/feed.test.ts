import { describe, expect, it } from "vitest";
import { discoverFeedUrls, parseFeed } from "../src/main/feed";

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

  it("keeps a bounded feed body only on the transient parsed item", async () => {
    const feed = await parseFeed(
      `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>测试订阅</title><item><title>完整条目</title><link>/post</link><description>卡片摘要</description><content:encoded><![CDATA[<p>订阅提供的 <strong>完整正文</strong></p>]]></content:encoded></item></channel></rss>`,
      "https://example.com/feed.xml"
    );

    expect(feed.entries[0]).toMatchObject({
      summary: "卡片摘要",
      feedContentHtml: "<p>订阅提供的 <strong>完整正文</strong></p>"
    });
  });

  it("keeps JSON Feed content_html on the transient item", async () => {
    const feed = await parseFeed(
      JSON.stringify({ version: "https://jsonfeed.org/version/1", title: "JSON Feed", items: [{ id: "x", url: "/post", title: "JSON 条目", content_html: "<p>完整 JSON 正文</p>" }] }),
      "https://example.com/feed.json"
    );

    expect(feed.entries[0]?.feedContentHtml).toBe("<p>完整 JSON 正文</p>");
  });

  it("skips metadata-less social and homepage links accidentally encoded as RSS items", async () => {
    const feed = await parseFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>AINews</title>
        <item><title>AINews</title><link>https://news.example/</link></item>
        <item><title>GitHub</title><link>https://github.com/example</link></item>
        <item><title>X (@example)</title><link>https://x.com/example</link></item>
        <item><title>A real sparse post</title><link>https://news.example/posts/real</link></item>
      </channel></rss>`,
      "https://news.example/"
    );
    expect(feed.entries).toEqual([expect.objectContaining({ title: "A real sparse post", url: "https://news.example/posts/real" })]);
  });

  it("discovers an RSS endpoint linked from a page footer", () => {
    const urls = discoverFeedUrls(
      `<html><body><footer><a href="/rss.xml" aria-label="RSS feed"><svg></svg></a></footer></body></html>`,
      "https://news.example/"
    );
    expect(urls).toEqual(["https://news.example/rss.xml"]);
  });

  it("accepts a type-declared Feed even when its path does not mention feeds", () => {
    const urls = discoverFeedUrls(
      `<link rel="alternate" type="application/atom+xml" href="/subscribe">`,
      "https://news.example/"
    );
    expect(urls).toEqual(["https://news.example/subscribe"]);
  });
});
