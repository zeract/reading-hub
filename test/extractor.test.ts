import { describe, expect, it } from "vitest";
import { extractCalibrationCandidates, extractGenericPage, extractPagePublishedAt, extractPublicationDateFromUrl } from "../src/main/extractor";
import { load } from "cheerio";
import { assertPublicUrl, canonicalizeContentUrl, canonicalizeUrl } from "../src/shared/url";

describe("generic-page extractor", () => {
  it("detects repeated article cards and preserves metadata", () => {
    const result = extractGenericPage(
      `<main>
        <article class="post-card"><h2><a href="/one?utm_source=test">第一篇文章</a></h2><time datetime="2026-08-12">2026-08-12</time><p>第一篇摘要足够长，方便验证摘要能够被识别并显示。</p><img src="/one.jpg"></article>
        <article class="post-card"><h2><a href="/two">第二篇文章</a></h2><time datetime="2026-08-13">2026-08-13</time><p>第二篇摘要足够长，方便验证摘要能够被识别并显示。</p></article>
        <article class="post-card"><h2><a href="/three">第三篇文章</a></h2><time datetime="2026-08-14">2026-08-14</time><p>第三篇摘要足够长，方便验证摘要能够被识别并显示。</p></article>
      </main>`,
      "https://example.com/news"
    );
    expect(result.fallback).toBe(false);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ title: "第一篇文章", url: "https://example.com/one?utm_source=test" });
    expect(result.rule?.itemRootSelector).toBe("article");
  });

  it("uses JSON-LD when it is present", () => {
    const result = extractGenericPage(
      `<script type="application/ld+json">{"@type":"Article","headline":"结构化文章","url":"/article","datePublished":"2026-08-14","description":"结构化摘要"}</script>`,
      "https://example.com/list"
    );
    expect(result.entries).toEqual([expect.objectContaining({ title: "结构化文章", url: "https://example.com/article" })]);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it("preserves dates from article metadata and a title-header byline in single-page fallbacks", () => {
    const nathan = extractGenericPage(
      `<meta property="og:title" content="How to Fix Hugo's iOS Code-Block Text-Size Rendering Issue"><meta property="og:url" content="/posts/fixing-ios-codeblocks/"><article><header class="post-header"><h1>How to Fix Hugo's iOS Code-Block Text-Size Rendering Issue</h1><div class="post-byline"><span>Nathan Barry</span><span>February 4, 2024</span></div></header><p>Article content, whose later table includes unrelated historical dates that must not win.</p></article>`,
      "https://nathan.rs/posts/fixing-ios-codeblocks/"
    );
    const vllm = extractGenericPage(
      `<meta property="og:title" content="A Preview of Production-Scale Kimi K3 Support on vLLM"><meta property="og:url" content="/blog/2026-07-22-kimi-k3-preview"><meta property="article:published_time" content="2026-07-22"><article><header><h1>A Preview of Production-Scale Kimi K3 Support on vLLM</h1><time dateTime="2026-07-22">July 22, 2026</time></header></article>`,
      "https://vllm.ai/blog/2026-07-22-kimi-k3-preview"
    );

    expect(nathan.entries[0]).toMatchObject({ publishedAt: Date.UTC(2024, 1, 4) });
    expect(vllm.entries[0]).toMatchObject({ publishedAt: Date.UTC(2026, 6, 22) });
  });

  it("does not assign a related-card date to an otherwise undated article", () => {
    const result = extractGenericPage(
      `<meta property="og:title" content="Undated article"><aside><time datetime="2026-08-16">A related post date</time></aside><article><header><h1>Undated article</h1></header><p>The article itself deliberately has no date.</p></article>`,
      "https://example.com/undated"
    );

    expect(result.entries[0]?.publishedAt).toBeUndefined();
  });

  it("recognizes repeated same-origin article links such as research.perplexity.ai", () => {
    const result = extractGenericPage(
      `<main>
        <a class="research-link" href="/articles/secure-runtimes"><time datetime="2026-08-12">2026-08-12</time><h2>Making secure and efficient runtimes for long-running agents</h2><p>Research notes about secure execution for long-running agent systems.</p></a>
        <a class="research-link" href="/articles/evaluating-agents"><time datetime="2026-08-13">2026-08-13</time><h2>Evaluating agent systems with realistic long horizon tasks</h2><p>Research notes about evaluation methods and agent reliability.</p></a>
        <a class="research-link" href="/articles/model-reasoning"><time datetime="2026-08-14">2026-08-14</time><h2>Improving model reasoning through targeted research methods</h2><p>Research notes about models, reasoning, and reliable automation.</p></a>
      </main>`,
      "https://research.perplexity.ai/"
    );
    expect(result.fallback).toBe(false);
    expect(result.entries.map((item) => item.url)).toContain("https://research.perplexity.ai/articles/secure-runtimes");
    expect(result.rule?.itemRootSelector).toMatch(/^a(?:\.research-link|\[href\*="\/articles\/"\])$/);
    const candidates = extractCalibrationCandidates(
      `<a href="/articles/one"><time>2026-08-12</time>A sufficiently long research article title for a first card</a>
       <a href="/articles/two"><time>2026-08-13</time>A sufficiently long research article title for a second card</a>`,
      "https://research.perplexity.ai/"
    );
    expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({ rule: expect.objectContaining({ itemRootSelector: 'a[href*="/articles/"]' }) })]));
  });

  it("keeps a link-card title separate from its date and excerpt", () => {
    const result = extractGenericPage(
      `<a class="research-link" href="/articles/secure-runtimes"><span>Jul 29, 2026</span><h2>Securing agents across client endpoints</h2><p>A concise article summary that must not be appended to the card title.</p></a>
       <a class="research-link" href="/articles/evaluating-agents"><span>Jul 28, 2026</span><h2>Evaluating agent systems carefully</h2><p>A second concise article summary that establishes a repeated article group.</p></a>`,
      "https://research.perplexity.ai/"
    );
    expect(result.entries[0]).toMatchObject({
      title: "Securing agents across client endpoints",
      publishedAt: Date.UTC(2026, 6, 29),
      summary: "A concise article summary that must not be appended to the card title."
    });
  });

  it("uses h5 headlines and substantial excerpts inside a whole-card link", () => {
    const result = extractGenericPage(
      `<main>
        <a class="framer-card" href="/articles/making-space">
          <p>sandbox</p><p>Jul 15, 2026</p>
          <h5>Making SPACE: Secure and Efficient Runtimes for Long-Running Agents</h5>
          <p>SPACE is a secure, efficient platform powering long-running agentic workflows and fast, isolated code execution.</p>
        </a>
        <a class="framer-card" href="/articles/wandr">
          <p>research</p><p>Jul 14, 2026</p>
          <h5>WANDR Benchmark: Evaluating Research Agents That Must Search Wide and Deep</h5>
          <p>A benchmark for high-volume, evidence-heavy knowledge work across realistic research tasks.</p>
        </a>
      </main>`,
      "https://research.example/"
    );

    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://research.example/articles/making-space",
        title: "Making SPACE: Secure and Efficient Runtimes for Long-Running Agents",
        summary: "SPACE is a secure, efficient platform powering long-running agentic workflows and fast, isolated code execution.",
        publishedAt: Date.UTC(2026, 6, 15)
      })
    ]));
  });

  it("uses article JSON-LD and dated URL paths only as safe page-level fallbacks", () => {
    expect(extractPagePublishedAt(load(`<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2026-07-22"}</script>`))).toBe(Date.UTC(2026, 6, 22));
    expect(extractPublicationDateFromUrl("https://vllm.ai/blog/2026-07-22-kimi-k3-preview")).toBe(Date.UTC(2026, 6, 22));
    expect(extractPublicationDateFromUrl("https://example.com/releases/v2026-07-22-not-a-post")).toBeUndefined();
  });

  it("offers a strongly evidenced single post card for user-confirmed calibration", () => {
    const html = `<main class="page-content"><div class="blog-container">
      <h1 class="page-title">Technical Blog</h1>
      <div class="blog-post-card" data-tags="agents,harness">
        <h2 class="blog-post-card-title"><a href="/blog/2026/07/agent-harness/">A complete technical post title with enough useful detail</a></h2>
        <div class="blog-post-card-meta"><time datetime="2026-07-06T00:50:00+00:00">July 6, 2026</time><span>28 min read</span></div>
        <p class="blog-post-card-excerpt">A detailed summary provides the article evidence required to safely monitor a blog that currently has only one public post.</p>
      </div>
    </div></main>`;
    const automatic = extractGenericPage(html, "https://jinyansu1.github.io/technical-blog/");
    const candidates = extractCalibrationCandidates(html, "https://jinyansu1.github.io/technical-blog/");

    expect(automatic.fallback).toBe(true);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: expect.stringContaining("单篇监测"),
        rule: expect.objectContaining({ itemRootSelector: "div.blog-post-card" }),
        preview: [expect.objectContaining({ title: "A complete technical post title with enough useful detail", url: "https://jinyansu1.github.io/blog/2026/07/agent-harness/" })]
      })
    ]));
  });

  it("rejects tag clouds and takes the article heading instead of a nested tag link", () => {
    const posts = ["first", "second", "third"]
      .map((slug) => `<article class="post-card">
        <ul class="tags"><li><a href="/tags/paper">paper</a></li><li><a href="/tags/RL">RL</a></li><li><a href="/tags/rocksdb">rocksdb</a></li></ul>
        <h2><a href="/posts/${slug}">A real article title ${slug} with useful technical detail</a></h2>
        <time datetime="2026-08-14">2026-08-14</time><p>This is a sufficiently detailed article summary that should be retained by the extractor.</p>
      </article>`)
      .join("");
    const result = extractGenericPage(`<main>${posts}</main>`, "http://heavensheep.xyz/");
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((item) => item.title)).toEqual(expect.arrayContaining(["A real article title first with useful technical detail"]));
    expect(result.entries.every((item) => item.url.includes("/posts/"))).toBe(true);
  });

  it("keeps a complete long-form blog archive such as accelazh.github.io", () => {
    const posts = Array.from({ length: 131 }, (_, index) => `<li>${String(index + 1).padStart(2, "0")} Jul 2026 » <a href="/posts/${index + 1}.html">A complete technical blog post title number ${index + 1}</a></li>`).join("");
    const html = `<main><ul>${posts}</ul></main>`;

    const detected = extractGenericPage(html, "https://accelazh.github.io/");
    const refreshed = extractGenericPage(html, "https://accelazh.github.io/", { version: 1, itemRootSelector: "li" });

    expect(detected.entries).toHaveLength(131);
    expect(detected.rule?.itemRootSelector).toBe("li");
    expect(detected.rule?.autoRepairRevision).toBeDefined();
    expect(refreshed.entries).toHaveLength(131);
    expect(refreshed.entries.at(-1)?.url).toBe("https://accelazh.github.io/posts/131.html");
  });

  it("repairs a stale narrow automatic rule when a complete archive is detected", () => {
    const posts = Array.from({ length: 130 }, (_, index) => `<li>16 Jul 2026 » <a href="/posts/${index + 1}.html">A complete technical blog post title number ${index + 1}</a></li>`).join("");
    const result = extractGenericPage(`<main><ul>${posts}</ul></main>`, "https://accelazh.github.io/", {
      version: 1,
      itemRootSelector: 'a[href*="/openstack/"]'
    });

    expect(result.entries).toHaveLength(130);
    expect(result.rule?.itemRootSelector).toBe("li");
    expect(result.rule?.autoRepairRevision).toBeDefined();
    expect(result.entries[0]?.publishedAt).toBe(Date.UTC(2026, 6, 16));
  });

  it("does not mistake version-like text for a publish date", () => {
    const result = extractGenericPage(
      `<main><ul><li><a href="/one">Install Devstack Havana on Ubuntu 12.04</a></li><li><a href="/two">Install RDO Icehouse on CentOS 6.3</a></li></ul></main>`,
      "https://accelazh.github.io/"
    );
    expect(result.entries.map((entry) => entry.publishedAt)).toEqual([undefined, undefined]);
  });

  it("falls back to the page card when an old saved rule only finds tags", () => {
    const result = extractGenericPage(
      `<meta property="og:title" content="The actual article"><meta property="og:url" content="/posts/actual"><meta property="og:description" content="The actual page summary">
       <ul class="tags"><li><a href="/tags/paper">paper</a></li><li><a href="/tags/RL">RL</a></li></ul>`,
      "http://heavensheep.xyz/",
      { version: 1, itemRootSelector: "li" }
    );
    expect(result).toMatchObject({ fallback: true, entries: [expect.objectContaining({ title: "The actual article", url: "http://heavensheep.xyz/posts/actual" })] });
  });
});

describe("canonical URL", () => {
  it("removes tracking parameters but preserves content identity", () => {
    expect(canonicalizeUrl("https://Example.com/post/?utm_source=rss&keep=yes#section")).toBe("https://example.com/post?keep=yes");
  });

  it("uses the stable Scour RSS wrapper path while ignoring delivery parameters", () => {
    expect(canonicalizeContentUrl("https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost?as=delivery-state"))
      .toBe("https://scour.ing/r/rss/https%3A%2F%2Fexample.com%2Fpost");
  });

  it("accepts public HTTP pages while still rejecting private network targets", () => {
    expect(assertPublicUrl("http://heavensheep.xyz/").protocol).toBe("http:");
    expect(() => assertPublicUrl("http://127.0.0.1:3000")).toThrow("不能添加本机或私有网络地址");
  });
});
