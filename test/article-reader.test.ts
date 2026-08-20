import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { ArticleReader, extractReaderArticle } from "../src/main/article-reader";
import type { PublicHttpClient } from "../src/main/http";
import { ScientificMathRenderer } from "../src/main/mathjax-renderer";
import type { PageRenderer } from "../src/main/page-renderer";
import type { Entry } from "../src/shared/types";
import type { Source } from "../src/shared/types";
import { RobotsDisallowedError } from "../src/main/robots";

const entry: Entry = {
  id: "entry-1",
  sourceId: "source-1",
  canonicalUrl: "https://example.com/articles/reader",
  url: "https://example.com/articles/reader",
  title: "备用标题",
  summary: "不应被当作正文截断显示。",
  contentHash: "hash",
  read: false,
  favorite: false,
  createdAt: 1
};

describe("article reader extraction", () => {
  it("uses the same safe page-date parser as source collection", () => {
    const result = extractReaderArticle(
      `<article><header class="post-header"><h1>带发布日期的文章</h1><div class="post-byline"><span>作者</span><span>February 4, 2024</span></div></header><p>${"正文内容 ".repeat(30)}</p></article>`,
      entry.url,
      entry
    );

    expect(result?.article.publishedAt).toBe(Date.UTC(2024, 1, 4));
  });

  it("keeps the complete article body and normalises relative images without allowing executable markup", () => {
    const longTitle = `完整标题 ${"不会被截断 ".repeat(40)}`.trim();
    const result = extractReaderArticle(
      `<html><head><meta property="og:title" content="${longTitle}"><meta property="og:image" content="/covers/hero.jpg"></head><body>
        <nav><a href="/home">导航，不属于正文</a></nav>
        <main><article class="post-content">
          <h1>${longTitle}</h1>
          <p>第一段完整正文，包含足够的上下文来验证文章阅读视图会保留段落。</p>
          <p>第二段完整正文，包含 <strong>强调文字</strong> 与 <a href="/reference">参考链接</a>。</p>
          <figure><img data-original="/images/diagram.png" alt="架构图"><figcaption>图注完整保留</figcaption></figure>
          <p>${"很长的正文内容 ".repeat(120)}</p>
          <a href="javascript:alert(1)" onclick="alert(1)">危险链接</a><script>alert(1)</script>
          <section class="comments"><p>评论区不应进入正文。</p></section>
        </article></main>
      </body></html>`,
      entry.url,
      entry
    );

    expect(result?.article.title).toBe(longTitle);
    expect(result?.textLength).toBeGreaterThan(900);
    expect(result?.article.coverImageUrl).toBe("https://example.com/covers/hero.jpg");
    expect(result?.article.contentHtml).toContain('src="https://example.com/images/diagram.png"');
    expect(result?.article.contentHtml).toContain('href="https://example.com/reference"');
    expect(result?.article.contentHtml).toContain("图注完整保留");
    expect(result?.article.contentHtml).not.toMatch(/script|onclick|javascript:|评论区/);
  });

  it("renders MathJax scripts and literal TeX while leaving source code untouched", () => {
    const result = extractReaderArticle(
      `<article>
        <p>目标分布是 $\\boldsymbol{p}=(p_1,p_2)$，并且 $p_i \\geq 0$。</p>
        <span class="MathJax_Preview">旧公式预览，不应重复显示</span><script type="math/tex; mode=display">L(\\boldsymbol{p}, \\boldsymbol{q}) = \\sum_i p_i S(\\boldsymbol{q}, i)</script><span id="MathJax-Element-1-Frame" class="MathJax">旧公式渲染副本，不应重复显示</span>
        <p>下面给出完整推导：</p>
        <p>\\begin{equation}\\newcommand{argmin}{\\mathop{\\text{argmin}}}\\boldsymbol{p} = \\argmin_{\\boldsymbol{q}} L(\\boldsymbol{p}, \\boldsymbol{q})\\label{eq:objective}\\end{equation}</p>
        <p>见 $\\eqref{eq:objective}$。</p>
        <pre><code>const literal = "$not_math$";</code></pre>
      </article>`,
      entry.url,
      entry
    );

    expect(result?.article.contentHtml).toContain('class="katex"');
    expect(result?.article.contentHtml).toContain("boldsymbol");
    expect(result?.article.contentHtml).toContain('class="katex-display"');
    expect(result?.article.contentHtml).toContain('annotation encoding="application/x-tex">L(\\boldsymbol{p}, \\boldsymbol{q})');
    expect(result?.article.contentHtml).not.toContain("newcommand");
    expect(result?.article.contentHtml).toContain("(1)");
    expect(result?.article.contentHtml).toContain('const literal = "$not_math$"');
    expect(result?.article.contentHtml).not.toContain("math/tex");
    expect(result?.article.contentHtml).not.toContain("READING_HUB_MATH");
    expect(result?.article.contentHtml).not.toContain("旧公式预览");
    expect(result?.article.contentHtml).not.toContain("旧公式渲染副本");
  });

  it("renders every explicitly delimited inline formula used by technical blogs", () => {
    const result = extractReaderArticle(
      `<article><p>对第 $t$ 个 query，序列长度记为 $L$，head 维度为 $d$，每个 block 的大小为 $B$；VAE 的压缩率是 $(4,16,16)$，复杂度为 $\mathcal{O}(L^2)$。${"这段正文用于保证内容提取稳定。 ".repeat(32)}</p></article>`,
      "https://www.haoyizhu.site/blog/sparse-linear-attention/",
      entry
    );

    const content = result?.article.contentHtml || "";
    const visible = load(`<article>${content}</article>`);
    visible(".katex, .reader-math-source").remove();
    expect(content).toContain('class="katex"');
    expect(content).not.toContain("$t$");
    expect(content).not.toContain("$L$");
    expect(content).not.toContain("$d$");
    expect(content).not.toContain("$B$");
    expect(content).not.toContain("$(4,16,16)$");
    expect(content).not.toContain("$\\mathcal{O}(L^2)$");
    expect(visible.text()).not.toContain("$");
  });

  it("shares MathJax macro declarations across article equations", () => {
    const result = extractReaderArticle(
      `<article>
        <script type="math/tex">\\def\\softcap{\\operatorname{softcap}}\\DeclareMathOperator{\\SiTU}{SiTU}</script>
        <p>函数为 $\\SiTU(x;\\beta)=\\softcap(x;\\beta)$，${"并保留足够的文章正文。 ".repeat(28)}</p>
      </article>`,
      entry.url,
      entry
    );

    expect(result?.article.contentHtml).toContain('class="katex"');
    expect(result?.article.contentHtml).toContain('mathvariant="normal">SiTU');
    expect(result?.article.contentHtml).toContain('mathvariant="normal">softcap');
    expect(result?.article.contentHtml).not.toContain("katex-error");
  });

  it("renders an align environment split across HTML line breaks", () => {
    const result = extractReaderArticle(
      `<article><p>LatentMoE与MoE的区别是：
        \\begin{align}<br>
        \\text{MoE:}&\\qquad\\qquad\\underbrace{d \\to D \\to d}_{n\\text{选}k} \\\\[5pt]<br>
        \\text{LatentMoE:}&\\qquad d\\to\\underbrace{d/2 \\to D \\to d/2}_{2n\\text{选}2k}\\to d \\\\<br>
        \\end{align}
        即LatentMoE会先降维，再做$2n$选$2k$的MoE，${"后续正文。 ".repeat(65)}</p></article>`,
      entry.url,
      entry
    );

    expect(result?.article.contentHtml).toContain('class="katex-display"');
    expect(result?.article.contentHtml).toContain("LatentMoE");
    expect(result?.article.contentHtml).not.toContain("katex-error");
    expect(result?.article.contentHtml).not.toContain("\\\\end{align}");
    expect(result?.article.contentHtml).not.toContain("$2n$");
    expect(result?.article.contentHtml).not.toContain("$2k$");
  });

  it("keeps a display array intact when a Scientific Spaces formula is split by HTML line breaks", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(24)}</p>
        <p>\$\$\\begin{array}{c|c}<br>\\text{名称} & H(\\boldsymbol{p}) \\\\<br>\\hline<br>\\text{Brier} & 1-\\sum_i p_i^2<br>\\end{array}\$\$</p>
      </article>`,
      "https://kexue.fm/archives/11854",
      entry,
      math
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain('class="katex-display"');
    const nonFormula = load(`<article>${content}</article>`);
    nonFormula(".katex, mjx-container").remove();
    expect(nonFormula.html()).not.toContain("\\begin{array}");
    expect(content).not.toContain("$$");
    expect(content).not.toContain("mjx-merror");
  });

  it("keeps Scientific Spaces cases formulas with left braces as one display block", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(24)}</p>
        <p>\\begin{equation}<br>
        q_i = \\left\\{ \\begin{array}{ll}<br>
        e^{z_i-\\lambda}, & \\alpha \\to 1 \\\\<br>
        [z_i-\\lambda-\\alpha g'(t)]_+^{\\frac{1}{\\alpha-1}}, & \\alpha \\ne 1<br>
        \\end{array} \\right.<br>
        \\end{equation}</p>
      </article>`,
      "https://kexue.fm/archives/11854",
      entry,
      math
    );

    const content = result?.article.contentHtml || "";
    const nonFormula = load(`<article>${content}</article>`);
    nonFormula(".katex, mjx-container").remove();
    expect(content).toContain('class="katex-display"');
    expect(content).not.toContain("reader-math-source");
    expect(nonFormula.text()).not.toMatch(/\\(?:left|right|begin|end|\{|\[)/);
    expect(content).not.toContain("mjx-merror");
  });

  it("renders the exact Scientific Spaces piecewise q_i equation without a partial MathJax tail", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(24)}</p>
        <script type="math/tex; mode=display">\\begin{equation}q_i = \\left\\{\\begin{aligned}
        &\\, e^{z_i - \\lambda},&\\, \\alpha \\to 1 \\\\
        &\\,\\left[\\frac{z_i - \\lambda}{-\\alpha g'(t)}\\right]_+^{\\frac{1}{\\alpha-1}},&\\, \\alpha \\neq 1 \\\\
        \\end{aligned}\\right.\\end{equation}</script>
      </article>`,
      "https://kexue.fm/archives/11854",
      entry,
      math
    );

    const content = result?.article.contentHtml || "";
    const visible = load(`<article>${content}</article>`);
    visible(".katex, mjx-container, .reader-math-source").remove();
    expect(content).toContain('class="katex-display"');
    expect(content).not.toContain("reader-math-source");
    expect(content).not.toContain("mjx-merror");
    expect(content).not.toContain("mjx-spacer");
    expect(visible.text()).not.toMatch(/\\(?:left|right|begin|end|\{|\[)/);
  });

  it("uses self-contained SVG rather than CHTML spacers for the Scientific Spaces fallback renderer", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const rendered = math.render(
      "\\begin{equation}q_i = \\left\\{\\begin{aligned}&\\, e^{z_i - \\lambda},&\\, \\alpha \\to 1 \\\\ &\\,\\left[\\frac{z_i - \\lambda}{-\\alpha g'(t)}\\right]_+^{\\frac{1}{\\alpha-1}},&\\, \\alpha \\neq 1\\end{aligned}\\right.\\end{equation}",
      true,
      {}
    ) || "";

    expect(rendered).toContain('jax="SVG"');
    expect(rendered).toContain("<svg");
    expect(rendered).not.toContain("mjx-spacer");
    expect(rendered).not.toContain("\\left");
  });

  it("renders Scientific Spaces formulas that require the cancel extension", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(24)}</p>
        <script type="math/tex; mode=display">\\require{cancel}\\cancel{S(q_i)} = \\cancel{S(q_i)} + q_i S'(q_i) - \\sum_j q_j^2 S'(q_j)</script>
      </article>`,
      "https://kexue.fm/archives/11854",
      entry,
      math
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain('class="katex-display"');
    expect(content).not.toContain("reader-math-source");
    expect(content).not.toContain("\\require");
    expect(content).not.toContain("mjx-merror");
  });

  it("turns TeX bibliography URLs into ordinary safe reader links", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(24)}</p><p>参考：\\url{https://kexue.fm/archives/11854}</p></article>`,
      "https://kexue.fm/archives/11854",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain('href="https://kexue.fm/archives/11854"');
    expect(content).not.toContain("\\url{");
  });

  it("uses the scientific MathJax profile for Scientific Spaces without duplicate previews or title anchors", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = extractReaderArticle(
      `<html><head>
        <script type="text/x-mathjax-config">MathJax.Hub.Config({ TeX: { Macros: { softcap: "\\\\operatorname{softcap}" } } });</script>
      </head><body><div id="post-body">
        <h1>LatentMoE 与 MoE</h1><h2>Norm <a class="headerlink" href="#norm">#</a></h2>
        <p>首页 数学研究 信息时代</p><p>9 Aug</p><p>By 苏剑林 | 2026-08-09 |</p>
        <p>LatentMoE与MoE的区别是：</p>
        <span class="MathJax_Preview">预览副本</span><script type="math/tex; mode=display">\\begin{align}\\text{MoE:}&\\qquad\\underbrace{d \\to D \\to d}_{n\\text{选}k} \\\\[5pt]\\text{LatentMoE:}&\\qquad d\\to\\underbrace{d/2 \\to D \\to d/2}_{2n\\text{选}2k}\\to d\\end{align}</script>
        <mjx-container display="true"><mjx-math><mjx-annotation encoding="application/x-tex">x^2</mjx-annotation></mjx-math></mjx-container>
        <p>函数使用 $\\softcap(x;\\beta)$，${"这是一段用于确认正文容器与公式可读性的文字。 ".repeat(24)}</p>
      </div></body></html>`,
      "https://kexue.fm/archives/11854",
      { ...entry, summary: "LatentMoE与MoE的区别是：" },
      math
    );

    const content = result?.article.contentHtml || "";
    const visible = load(`<article>${content}</article>`);
    visible(".katex, mjx-container, .reader-math-source").remove();
    expect(result?.article.renderProfile).toBe("scientific");
    expect(content).toContain('class="katex"');
    expect(content).not.toContain("预览副本");
    expect(content).not.toContain("READING_HUB_MATH");
    expect(visible.text()).not.toContain("\\begin{align}");
    expect(content).not.toContain("mjx-merror");
    expect(content).not.toContain("mjx-spacer");
    expect(content).not.toContain("Norm #");
    expect(content).not.toContain("首页 数学研究 信息时代");
    expect(content).not.toContain("By 苏剑林");
  });

  it("removes Scientific Spaces chrome when the first article paragraph is nested", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = extractReaderArticle(
      `<html><body><main><div class="site-shell"><nav>首页 数学研究 信息时代</nav><header><h1>不应重复的标题</h1><p>By 苏剑林 | 2026-08-09 |</p></header><section><div><p>真正的第一段正文，应该成为阅读器的起点。${"后续内容。".repeat(50)}</p></div></section></div></main></body></html>`,
      "https://kexue.fm/archives/11854",
      { ...entry, summary: "真正的第一段正文，应该成为阅读器的起点。" },
      math
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain("真正的第一段正文");
    expect(content).not.toContain("首页");
    expect(content).not.toContain("不应重复的标题");
    expect(content).not.toContain("By 苏剑林");
  });

  it("does not emit third-party stylesheet parse warnings while using Readability", () => {
    const warnings: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => warnings.push(args);
    try {
      extractReaderArticle(
        `<html><head><style>invalid { --broken: {; }</style></head><body><main>${"<p>可读正文内容。</p>".repeat(45)}</main></body></html>`,
        entry.url,
        entry
      );
    } finally {
      console.error = originalError;
    }
    expect(warnings).toEqual([]);
  });

  it("preserves Markdown semantics and hydrates lazy responsive images", () => {
    const result = extractReaderArticle(
      `<article class="post-content">
        <h1>富文本 Markdown 文章</h1>
        <p>${"正文内容 ".repeat(35)}<mark>重点</mark>，按 <kbd>⌘K</kbd>，得到 x<sup>2</sup> 与 H<sub>2</sub>O。</p>
        <details><summary>展开说明</summary><p>详细的 Markdown 折叠内容应保留。</p></details>
        <dl><dt>术语</dt><dd>对应定义</dd></dl>
        <ul><li><input type="checkbox" checked> 已完成任务</li><li><input type="checkbox"> 待完成任务</li></ul>
        <picture><source srcset="/image-small.webp 320w, /image-large.webp 1280w"><img src="/placeholder.gif" alt="响应式插图"></picture>
        <img src="" alt="noscript 插图"><noscript><img src="/fallback-image.png" alt="noscript 插图"></noscript>
      </article>`,
      entry.url,
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain("<mark>重点</mark>");
    expect(content).toContain("<kbd>⌘K</kbd>");
    expect(content).toContain("<sup>2</sup>");
    expect(content).toContain("<sub>2</sub>");
    expect(content).toContain("<details open");
    expect(content).toContain("<dl>");
    expect(content).toContain("☑");
    expect(content).toContain("☐");
    expect(content).not.toContain("<input");
    expect(content).toContain('src="https://example.com/image-large.webp"');
    expect(content).toContain('src="https://example.com/fallback-image.png"');
    expect(load(content)("img[src='https://example.com/fallback-image.png']")).toHaveLength(1);
    expect(content).toContain('data-reader-zoomable="true"');
    expect(content).toContain('role="button"');
  });

  it("keeps an in-body Open Graph image only once instead of rendering a duplicate cover", () => {
    const result = extractReaderArticle(
      `<html><head><meta property="og:image" content="/images/hero.png"></head><body><article class="post-content">
        <p>${"正文内容 ".repeat(35)}</p><figure><img src="/images/hero.png" alt="文章首图"><figcaption>首图图注</figcaption></figure>
      </article></body></html>`,
      entry.url,
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(result?.article.coverImageUrl).toBeUndefined();
    expect(load(content)("img[src='https://example.com/images/hero.png']")).toHaveLength(1);
    expect(content).toContain("首图图注");
  });

  it("keeps the highest-resolution WordPress image when noscript and lazy variants coexist", () => {
    const image = "https://developer-blogs.nvidia.com/wp-content/uploads/2020/11/Figure1-625x125.png";
    const originalImage = "https://developer-blogs.nvidia.com/wp-content/uploads/2020/11/Figure1.png";
    const result = extractReaderArticle(
      `<article class="entry-content">
        <p>${"正文内容 ".repeat(35)}</p>
        <figure class="wp-lightbox-container">
          <noscript><img src="${image}" srcset="${image} 625w, ${originalImage} 1206w" alt="Roofline 图"></noscript>
          <img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" data-src="${image}" data-srcset="${image} 625w, ${originalImage} 1206w" alt="Roofline 图" class="lazyload">
          <button type="button">放大</button>
          <figcaption>Figure 1. Roofline 图。</figcaption>
        </figure>
      </article>`,
      entry.url,
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(`img[src='${originalImage}']`)).toHaveLength(1);
    expect(load(content)(`img[src='${image}']`)).toHaveLength(0);
    expect(content).toContain("Figure 1. Roofline 图。");
    expect(content).not.toContain("data:image/svg");
  });

  it("preserves a linked Substack picture instead of replacing it with its image URL", () => {
    const image = "https://substackcdn.com/image/fetch/$s_!example!,w_1456,c_limit,f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fdiagram.png";
    const result = extractReaderArticle(
      `<article><p>${"正文内容 ".repeat(35)}</p>
        <figure><a href="${image}"><picture><source type="image/webp" srcset="${image} 1456w"><img src="${image}" alt="Substack 图"></picture></a><figcaption>图片说明。</figcaption></figure>
      </article>`,
      "https://magazine.sebastianraschka.com/p/example",
      entry
    );

    const content = result?.article.contentHtml || "";
    const document = load(content);
    expect(document(`img[src='${image}']`)).toHaveLength(1);
    expect(document("a img")).toHaveLength(1);
    expect(document("a").text()).not.toBe(image);
    expect(content).toContain("图片说明。");
  });

  it("does not remove the same image when it is intentionally used in separate figures", () => {
    const image = "https://example.com/images/reused-diagram.png";
    const result = extractReaderArticle(
      `<article><p>${"正文内容 ".repeat(35)}</p>
        <figure><img src="${image}" alt="第一次出现"><figcaption>图一</figcaption></figure>
        <p>中间说明。</p>
        <figure><img src="${image}" alt="第二次出现"><figcaption>图二</figcaption></figure>
      </article>`,
      entry.url,
      entry
    );

    expect(load(result?.article.contentHtml || "")(`img[src='${image}']`)).toHaveLength(2);
  });

  it("uses the isolated renderer after a non-robots HTTP failure", async () => {
    const http = {
      getText: async () => { throw new Error("请求失败（HTTP 403）"); }
    } as unknown as PublicHttpClient;
    const renderer: PageRenderer = {
      render: async () => `<article><h1>渲染后正文</h1><p>${"可读正文 ".repeat(80)}</p><p>公式 $p_i \\geq 0$。</p></article>`
    };

    const article = await new ArticleReader(http, renderer).read(entry);

    expect(article.title).toBe("渲染后正文");
    expect(article.contentHtml).toContain('class="katex"');
  });

  it("renders a feed-provided X summary locally when the original page is blocked by robots", async () => {
    const http = {
      getText: async () => { throw new RobotsDisallowedError(); }
    } as unknown as PublicHttpClient;
    const renderer: PageRenderer = {
      render: async () => { throw new Error("robots fallback must not render the original X page"); }
    };
    const source: Source = {
      id: "rsshub-x", url: "http://127.0.0.1:1200/twitter/user/example", title: "Twitter @example", kind: "rss", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };
    const xEntry: Entry = {
      ...entry,
      url: "https://x.com/example/status/1",
      canonicalUrl: "https://x.com/example/status/1",
      summary: "这是 RSS 订阅已提供的 X 内容摘要，能够在不读取受 robots 限制原页的前提下安全显示。<img src=x onerror=alert(1)>"
    };

    const article = await new ArticleReader(http, renderer).read(xEntry, source);

    expect(article.contentMode).toBe("feed_summary");
    expect(article.contentHtml).toContain("RSS 订阅已提供的 X 内容摘要");
    expect(article.contentHtml).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(article.contentHtml).not.toContain("<img");
  });

  it("dynamically sanitizes a subscribed RSSHub item body without reading or storing the blocked X page", async () => {
    const source: Source = {
      id: "rsshub-x", url: "http://127.0.0.1:1200/twitter/user/example", title: "Twitter @example", kind: "rss", status: "active",
      config: { allowTrustedLoopbackFeed: true }, pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };
    const xEntry: Entry = {
      ...entry,
      url: "https://x.com/example/status/1",
      canonicalUrl: "https://x.com/example/status/1",
      summary: "这是卡片摘要，不应作为完整 Feed 正文。",
      imageUrl: "https://pbs.twimg.com/media/diagram.jpg"
    };
    const requests: Array<{ url: string; options?: unknown }> = [];
    const http = {
      getText: async (url: string, _cached?: unknown, options?: unknown) => {
        requests.push({ url, options });
        if (url === xEntry.url) throw new RobotsDisallowedError();
        if (url === source.url) {
          return {
            url: source.url,
            status: 200,
            contentType: "application/rss+xml",
            text: `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>RSSHub</title><item><title>示例推文</title><link>${xEntry.url}</link><description>${xEntry.summary}</description><content:encoded><![CDATA[<p>RSSHub 提供的 <strong>完整推文正文</strong>，可在本地安全阅读。</p><img src="https://pbs.twimg.com/media/diagram.jpg" onerror="alert(1)"><script>alert(1)</script>]]></content:encoded></item></channel></rss>`
          };
        }
        throw new Error("不应请求其他地址");
      }
    } as unknown as PublicHttpClient;
    const renderer: PageRenderer = {
      render: async () => { throw new Error("不能渲染受 robots 限制的 X 原页"); }
    };

    const article = await new ArticleReader(http, renderer).read(xEntry, source);

    expect(article.contentMode).toBe("feed_body");
    expect(article.contentHtml).toContain("RSSHub 提供的");
    expect(article.contentHtml).toContain('src="https://pbs.twimg.com/media/diagram.jpg"');
    expect(article.contentHtml).not.toMatch(/script|onerror/);
    expect(article.coverImageUrl).toBeUndefined();
    expect(requests).toEqual([
      { url: xEntry.url, options: { maxBytes: 8_000_000 } },
      { url: source.url, options: { allowTrustedLoopbackFeed: true } }
    ]);
  });

  it("keeps the restricted original-page fallback when a feed has no useful summary", async () => {
    const http = {
      getText: async () => { throw new RobotsDisallowedError(); }
    } as unknown as PublicHttpClient;
    const source: Source = {
      id: "rsshub-x", url: "http://127.0.0.1:1200/twitter/user/example", title: "Twitter @example", kind: "rss", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };

    await expect(new ArticleReader(http, { render: async () => "" }).read({ ...entry, summary: "过短摘要" }, source)).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("uses the dedicated Zhihu session before any public HTTP request", async () => {
    const http = {
      getText: async () => { throw new Error("公开 HTTP 不应被调用"); }
    } as unknown as PublicHttpClient;
    const source: Source = {
      id: "zhihu-source", url: "https://www.zhihu.com/follow", title: "知乎关注动态", kind: "zhihu_follow", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };
    const reader = new ArticleReader(http, { render: async () => "" }, async () => `<div class="RichContent-inner"><p>${"授权会话正文 ".repeat(80)}</p></div>`);

    const article = await reader.read(entry, source);

    expect(article.contentHtml).toContain("授权会话正文");
  });

  it("prefers the semantic article over a page container with navigation and comments", () => {
    const result = extractReaderArticle(
      `<main>
        <div class="site-sidebar"><h2>CATEGORIES</h2><a href="/category">分类</a><a href="/archive">归档</a></div>
        <article><h1>真正的文章</h1><p>${"文章段落 ".repeat(90)}</p></article>
        <div class="site-comments"><h2>COMMENTS</h2><a href="/comment">读者评论</a></div>
      </main>`,
      entry.url,
      entry
    );

    expect(result?.article.title).toBe("真正的文章");
    expect(result?.article.contentHtml).toContain("文章段落");
    expect(result?.article.contentHtml).not.toContain("CATEGORIES");
    expect(result?.article.contentHtml).not.toContain("读者评论");
  });

  it("uses a conventional #main content container when no article element exists", () => {
    const result = extractReaderArticle(
      `<div id="main"><h1>无 article 标签的页面</h1><p>${"正文内容 ".repeat(80)}</p></div>`,
      entry.url,
      entry
    );

    expect(result?.article.title).toBe("无 article 标签的页面");
    expect(result?.article.contentHtml).toContain("正文内容");
  });

  it("uses a named Framer content section instead of the full page shell", () => {
    const result = extractReaderArticle(
      `<div id="main"><div data-framer-name="Navigation"><p>首页 关于 联系</p></div><div data-framer-name="Information"><h1>Framer 文章</h1><p>${"文章主体 ".repeat(80)}</p></div></div>`,
      entry.url,
      entry
    );

    expect(result?.article.title).toBe("Framer 文章");
    expect(result?.article.contentHtml).not.toContain("首页 关于 联系");
  });

  it("removes a source title and metadata duplicated by the reader header", () => {
    const result = extractReaderArticle(
      `<article><h1>重复的标题</h1><p class="post-meta">By 作者 | 2026-08-09 | 6246位读者 |</p><p>${"正文内容 ".repeat(80)}</p></article>`,
      entry.url,
      { ...entry, title: "重复的标题" }
    );

    expect(result?.article.title).toBe("重复的标题");
    expect(result?.article.contentHtml).not.toContain("重复的标题");
    expect(result?.article.contentHtml).not.toContain("6246位读者");
  });
});
