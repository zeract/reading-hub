import { describe, expect, it, vi } from "vitest";
import { ResponseTooLargeError } from "../src/main/http";
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

  it("accepts a single card in an explicit Blog Posts section without falling back to a publication list", async () => {
    const html = `<section>
      <h2 id="selected-publications">Selected Publications</h2>
      <ol class="bibliography">
        <li><div class="title"><a href="https://papers.example/one">A long publication title that should not become a blog card</a></div></li>
        <li><div class="title"><a href="https://papers.example/two">Another long publication title that should not become a blog card</a></div></li>
      </ol>
      <h2 id="blogs">Blog Posts</h2>
      <div class="blogs"><div class="blog-row"><div class="blog-content">
        <div class="blog-title"><a href="/blog/2026/08/27/beyond-RL/">A Gallery of Methods Beyond RL — Part I: Sampling Methods</a></div>
        <div class="blog-description">A tour of methods beyond reinforcement learning.</div>
      </div><div class="blog-date">Aug 2026</div></div></div>
    </section>`;
    const http = {
      getText: vi.fn().mockResolvedValue({
        url: "https://shengyu-feng.github.io/",
        status: 200,
        contentType: "text/html",
        text: html
      })
    };
    const renderer = { render: vi.fn() };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://shengyu-feng.github.io/")).resolves.toMatchObject({
      kind: "generic",
      requiresReview: false,
      extractionRule: { itemRootSelector: "h2#blogs + div.blogs div.blog-row" },
      preview: [expect.objectContaining({ url: "https://shengyu-feng.github.io/blog/2026/08/27/beyond-RL/" })]
    });
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("records an explicit archive descriptor without downloading history during Feed preview", async () => {
    const http = {
      getText: vi.fn(async (url: string) => {
        if (url === "https://example.com/feed.xml") {
          return {
            url,
            status: 200,
            contentType: "application/rss+xml",
            text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><link>https://example.com/</link><item><title>Current post</title><link>/post/current</link></item></channel></rss>`
          };
        }
        if (url === "https://example.com/") {
          return { url, status: 200, contentType: "text/html", text: `<a href="/archive.html">Archive</a>` };
        }
        throw new Error(`unexpected history request: ${url}`);
      })
    };
    const probe = new SourceProbe(http as any);

    await expect(probe.probe("https://example.com/feed.xml")).resolves.toMatchObject({
      kind: "rss",
      historicalArchiveUrl: "https://example.com/archive.html",
      message: expect.stringContaining("默认只收集 Feed 最新内容")
    });
    expect(http.getText.mock.calls.map(([url]) => url)).toEqual(["https://example.com/feed.xml", "https://example.com/"]);
  });

  it("does not attach an aggregator's archive to a third-party Feed", async () => {
    const http = {
      getText: vi.fn(async (url: string) => {
        if (url === "https://aggregator.example/") {
          return {
            url,
            status: 200,
            contentType: "text/html",
            text: `<link rel="alternate" type="application/rss+xml" href="https://publisher.example/feed.xml"><a href="/archive.html">Archive</a>`
          };
        }
        if (url === "https://publisher.example/feed.xml") {
          return {
            url,
            status: 200,
            contentType: "application/rss+xml",
            text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Publisher</title><link>https://publisher.example/</link><item><title>Post</title><link>/post</link></item></channel></rss>`
          };
        }
        if (url === "https://publisher.example/") {
          return { url, status: 200, contentType: "text/html", text: "<main>Publisher homepage</main>" };
        }
        throw new Error(`unexpected archive request: ${url}`);
      })
    };
    const probe = new SourceProbe(http as any);

    await expect(probe.probe("https://aggregator.example/")).resolves.toMatchObject({
      kind: "rss",
      url: "https://publisher.example/feed.xml",
      historicalArchiveUrl: undefined
    });
    expect(http.getText.mock.calls.map(([url]) => url)).toEqual([
      "https://aggregator.example/",
      "https://publisher.example/feed.xml",
      "https://publisher.example/"
    ]);
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

  it("uses the isolated renderer for an oversized HTML page and records that choice", async () => {
    const http = {
      getText: vi.fn().mockRejectedValue(new ResponseTooLargeError(
        3_000_000,
        "text/html; charset=utf-8",
        "https://example.com/archive",
        3_000_001
      ))
    };
    const renderer = {
      render: vi.fn().mockResolvedValue(`<main><ul>
        <li><a href="/one">A sufficiently descriptive first post</a><time datetime="2026-08-20">20 Aug 2026</time></li>
        <li><a href="/two">A sufficiently descriptive second post</a><time datetime="2026-08-19">19 Aug 2026</time></li>
      </ul></main>`)
    };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://example.com/archive")).resolves.toMatchObject({
      kind: "generic",
      extractionRule: expect.objectContaining({ rendererRequired: true }),
      preview: expect.arrayContaining([expect.objectContaining({ title: "A sufficiently descriptive first post" })]),
      message: "已使用浏览器渲染模式识别该公开网页。"
    });
    expect(renderer.render).toHaveBeenCalledWith("https://example.com/archive", undefined);
  });

  it("uses the isolated renderer when an oversized HTML page is mislabeled as plain text", async () => {
    const http = {
      getText: vi.fn().mockRejectedValue(new ResponseTooLargeError(
        3_000_000,
        "text/plain",
        "https://example.com/archive",
        3_000_001
      ))
    };
    const renderer = {
      render: vi.fn().mockResolvedValue(`<main><ul>
        <li><a href="/one">A sufficiently descriptive first post</a><time datetime="2026-08-20">20 Aug 2026</time></li>
        <li><a href="/two">A sufficiently descriptive second post</a><time datetime="2026-08-19">19 Aug 2026</time></li>
      </ul></main>`)
    };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://example.com/archive")).resolves.toMatchObject({
      kind: "generic",
      extractionRule: expect.objectContaining({ rendererRequired: true })
    });
    expect(renderer.render).toHaveBeenCalledWith("https://example.com/archive", undefined);
  });

  it("uses the isolated renderer for a non-Feed XML response that exceeds the page budget", async () => {
    const http = {
      getText: vi.fn().mockRejectedValue(new ResponseTooLargeError(
        3_000_000,
        "application/xml",
        "https://example.com/archive",
        3_000_001,
        "page"
      ))
    };
    const renderer = {
      render: vi.fn().mockResolvedValue(`<main><ul>
        <li><a href="/one">A sufficiently descriptive first post</a><time datetime="2026-08-20">20 Aug 2026</time></li>
        <li><a href="/two">A sufficiently descriptive second post</a><time datetime="2026-08-19">19 Aug 2026</time></li>
      </ul></main>`)
    };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://example.com/archive")).resolves.toMatchObject({ kind: "generic" });
    expect(renderer.render).toHaveBeenCalledWith("https://example.com/archive", undefined);
  });

  it("does not treat a signature-verified oversized Feed as an HTML page", async () => {
    const error = new ResponseTooLargeError(12_000_000, "application/rss+xml", "https://example.com/feed.xml", 12_000_001, "feed");
    const http = { getText: vi.fn().mockRejectedValue(error) };
    const renderer = { render: vi.fn() };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://example.com/feed.xml")).rejects.toBe(error);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("allows a mislabeled Feed MIME response to use the page fallback when it was not verified as a Feed", async () => {
    const http = {
      getText: vi.fn().mockRejectedValue(new ResponseTooLargeError(
        3_000_000,
        "application/rss+xml",
        "https://example.com/archive",
        3_000_001,
        "page"
      ))
    };
    const renderer = { render: vi.fn().mockResolvedValue("<main><p>HTML page</p></main>") };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://example.com/archive")).resolves.toMatchObject({ kind: "generic" });
    expect(renderer.render).toHaveBeenCalledWith("https://example.com/archive", undefined);
  });

  it("does not hand an arbitrary oversized application response to Chromium", async () => {
    const error = new ResponseTooLargeError(3_000_000, "application/javascript", "https://example.com/app.js", 3_000_001);
    const http = { getText: vi.fn().mockRejectedValue(error) };
    const renderer = { render: vi.fn() };
    const probe = new SourceProbe(http as any, renderer as any);

    await expect(probe.probe("https://example.com/app.js")).rejects.toBe(error);
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
