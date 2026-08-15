import { describe, expect, it } from "vitest";
import { extractZhihuFollowPage } from "../src/main/zhihu-follow-parser";

describe("Zhihu Follow feed parser", () => {
  it("uses the content link and heading instead of profile or interaction links", () => {
    const entries = extractZhihuFollowPage(
      `<section class="TopstoryItem">
        <a class="AuthorInfo-name" href="/people/example-author">示例作者</a>
        <a href="/people/example-author">关注</a>
        <h2 class="ContentItem-title"><a href="/question/123/answer/456">关注用户发布的真实回答标题</a></h2>
        <div class="RichContent-inner"><p>这是关注动态中应当显示的文章摘要，长度足以识别为正文内容。</p></div>
        <time datetime="2026-08-15T10:30:00+08:00">刚刚</time><img data-actualsrc="https://picx.zhimg.com/demo.jpg">
      </section>
      <section class="TopstoryItem"><a href="/people/not-content">只有作者主页，不是内容</a></section>`,
      "https://www.zhihu.com/follow"
    );
    expect(entries).toEqual([
      expect.objectContaining({
        url: "https://www.zhihu.com/question/123/answer/456",
        title: "关注用户发布的真实回答标题",
        author: "示例作者",
        summary: "这是关注动态中应当显示的文章摘要，长度足以识别为正文内容。",
        imageUrl: "https://picx.zhimg.com/demo.jpg"
      })
    ]);
    expect(entries[0].publishedAt).toBe(Date.parse("2026-08-15T10:30:00+08:00"));
  });

  it("keeps one canonical entry when nested cards point to the same Zhihu content", () => {
    const entries = extractZhihuFollowPage(
      `<article class="TopstoryItem"><div class="ContentItem"><h2><a href="https://zhuanlan.zhihu.com/p/12345">一篇专栏文章</a></h2><p>足够长的内容摘要，用于验证嵌套卡片不会产生重复内容。</p></div></article>`,
      "https://www.zhihu.com/follow"
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ url: "https://zhuanlan.zhihu.com/p/12345", title: "一篇专栏文章" });
  });

  it("excludes ideas and bare question activity, while retaining authored posts", () => {
    const entries = extractZhihuFollowPage(
      `<section class="TopstoryItem">
        <span>示例作者发布了想法</span><a href="/pin/987654">这是一条不应被收集的想法</a>
      </section>
      <section class="TopstoryItem">
        <span>示例作者提出了问题</span><a href="/question/24680">这是一条不应被收集的问题动态</a>
      </section>
      <section class="TopstoryItem">
        <h2><a href="/question/24680/answer/13579">这是一篇应保留的知乎回答</a></h2>
        <p>这段足够长的摘要用于确认筛选不会误删关注用户发布的回答内容。</p>
      </section>`,
      "https://www.zhihu.com/follow"
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      url: "https://www.zhihu.com/question/24680/answer/13579",
      title: "这是一篇应保留的知乎回答"
    });
  });

  it("prefers the content creation timestamp embedded in Zhihu card metadata", () => {
    const entries = extractZhihuFollowPage(
      `<section class="TopstoryItem" data-za-extra-module='{"card":{"created_time":1723689000}}'>
        <h2><a href="/question/123/answer/789">带真实创建时间的回答</a></h2><p>这是一段足够长的摘要，用于验证知乎卡片的真实时间提取。</p>
        <time>刚刚</time>
      </section>`,
      "https://www.zhihu.com/follow"
    );
    expect(entries[0].publishedAt).toBe(1_723_689_000_000);
  });
});
