import { describe, expect, it, vi } from "vitest";
import { SourceProbe } from "../src/main/source-probe";

describe("SourceProbe platform boundaries", () => {
  it("rejects X profile URLs before the generic web probe reads a robots-blocked page", async () => {
    const http = { getText: vi.fn() };
    const probe = new SourceProbe(http as any);

    await expect(probe.probe("https://x.com/archiexzzz")).rejects.toThrow("不能通过“网页 / Feed”自动探测");
    await expect(probe.calibrate("https://twitter.com/archiexzzz")).rejects.toThrow("robots.txt 禁止自动读取");
    expect(http.getText).not.toHaveBeenCalled();
  });

  it("prefers a verified footer RSS link when a site omits rel=alternate", async () => {
    const http = {
      getText: vi.fn(async (url: string) => url.endsWith("/rss.xml")
        ? {
            url,
            status: 200,
            contentType: "application/rss+xml",
            text: `<?xml version="1.0"?><rss version="2.0"><channel><title>AINews</title><item><title>New issue</title><link>/issues/new</link><pubDate>Tue, 18 Aug 2026 05:44:39 GMT</pubDate></item></channel></rss>`
          }
        : {
            url,
            status: 200,
            contentType: "text/html",
            text: `<html><head><title>AINews</title></head><body><footer><a href="/rss.xml">RSS</a></footer></body></html>`
          })
    };
    const probe = new SourceProbe(http as any);

    await expect(probe.probe("https://news.example/")).resolves.toMatchObject({
      kind: "rss",
      url: "https://news.example/rss.xml",
      preview: [expect.objectContaining({ title: "New issue" })]
    });
  });

  it("accepts an explicit loopback endpoint only when it is a real feed", async () => {
    const http = {
      getText: vi.fn(async () => ({
        url: "http://127.0.0.1:1200/twitter/user/example",
        status: 200,
        contentType: "application/rss+xml",
        text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Local feed</title><item><title>Post</title><link>https://x.com/example/status/1</link></item></channel></rss>`
      }))
    };
    const probe = new SourceProbe(http as any);

    await expect(probe.probe("http://127.0.0.1:1200/twitter/user/example")).resolves.toMatchObject({
      kind: "rss",
      title: "Local feed",
      message: expect.stringContaining("本机 Feed")
    });
    expect(http.getText).toHaveBeenCalledWith(
      "http://127.0.0.1:1200/twitter/user/example",
      undefined,
      { allowTrustedLoopbackFeed: true }
    );
  });
});
