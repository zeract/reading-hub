import { describe, expect, it, vi } from "vitest";
import { load } from "cheerio";
import { ArticleReader, extractReaderArticle, extractReaderArticleAsync } from "../src/main/article-reader";
import type { PublicHttpClient } from "../src/main/http";
import { ScientificMathRenderer, sanitizeMathJaxSvg } from "../src/main/mathjax-renderer";
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
  it("prefers a named body over nested related-article cards", () => {
    const body = "这个系列面向顶会阅读与工程判断，系统梳理数据库研究与工程实践。".repeat(18);
    const result = extractReaderArticle(
      `<html><body><div class="page">
        <main class="post-body"><header><h1>数据库前沿理论研究</h1></header><p>${body}</p></main>
        <section class="post-recommendations__grid"><article class="post-recommendation-card"><h2>推荐文章</h2><p>这不是当前文章的正文。</p></article></section>
      </div></body></html>`,
      "https://example.com/post/db-frontier/index.html",
      { ...entry, title: "数据库前沿理论研究" }
    );

    expect(result?.article.title).toBe("数据库前沿理论研究");
    expect(result?.article.contentHtml).toContain("这个系列面向顶会阅读与工程判断");
    expect(result?.article.contentHtml).not.toContain("这不是当前文章的正文");
    expect(result?.textLength).toBeGreaterThan(500);
  });

  it("uses the same safe page-date parser as source collection", () => {
    const result = extractReaderArticle(
      `<article><header class="post-header"><h1>带发布日期的文章</h1><div class="post-byline"><span>作者</span><span>February 4, 2024</span></div></header><p>${"正文内容 ".repeat(30)}</p></article>`,
      entry.url,
      entry
    );

    expect(result?.article.publishedAt).toBe(Date.UTC(2024, 1, 4));
  });

  it("discovers author-declared native language versions without guessing from an arbitrary URL", () => {
    const result = extractReaderArticle(
      `<html lang="en"><head><link rel="alternate" hreflang="zh-Hans" href="/reinforcement-learning/2025/12/01/kl-estimators-zh.html"></head><body>
        <article><header><h1>KL Estimators</h1><a href="/reinforcement-learning/2025/12/01/kl-estimators-zh.html">中文版本 →</a></header>
        <p>${"A complete English article body. ".repeat(30)}</p></article>
      </body></html>`,
      "https://xihuai18.github.io/reinforcement-learning/2025/12/01/kl-estimators-en.html",
      entry
    );

    expect(result?.article.activeLanguage).toBe("en");
    expect(result?.article.url).toBe("https://xihuai18.github.io/reinforcement-learning/2025/12/01/kl-estimators-en.html");
    expect(result?.article.languageVariants).toEqual([
      { url: "https://xihuai18.github.io/reinforcement-learning/2025/12/01/kl-estimators-en.html", language: "en", label: "English" },
      { url: "https://xihuai18.github.io/reinforcement-learning/2025/12/01/kl-estimators-zh.html", language: "zh", label: "中文" }
    ]);
  });

  it("does not treat an arbitrary off-site language-labelled link as an article version", () => {
    const result = extractReaderArticle(
      `<html lang="en"><body><article><h1>Original article</h1>
        <p>${"Enough article prose to make this extraction stable. ".repeat(30)}</p>
        <p><a href="https://translator.example/translated-copy">中文版本</a></p>
      </article></body></html>`,
      entry.url,
      entry
    );

    expect(result?.article.languageVariants).toEqual([
      { url: entry.url, language: "en", label: "English" }
    ]);
  });

  it("does not mistake a site-wide language navigation for an article version", () => {
    const result = extractReaderArticle(
      `<html lang="en"><body><nav><a href="/zh/">中文版本</a></nav><article><h1>Original article</h1>
        <p>${"Enough article prose to make this extraction stable. ".repeat(30)}</p>
      </article></body></html>`,
      entry.url,
      entry
    );

    expect(result?.article.languageVariants).toEqual([
      { url: entry.url, language: "en", label: "English" }
    ]);
  });

  it("keeps a neutral original-language entry when the publisher omits html lang", () => {
    const result = extractReaderArticle(
      `<html><body><article><header><h1>Original article</h1><a href="/articles/translated">中文版本</a></header>
        <p>${"Enough article prose to make this extraction stable. ".repeat(30)}</p>
      </article></body></html>`,
      entry.url,
      entry
    );

    expect(result?.article.activeLanguage).toBe("und");
    expect(result?.article.languageVariants).toEqual([
      { url: entry.url, language: "und", label: "原文" },
      { url: "https://example.com/articles/translated", language: "zh", label: "中文" }
    ]);
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

  it("keeps one formula when MathJax retains both the authored script and its visual frame", () => {
    const tex = "\\begin{equation}\\newcommand{\\rcos}{\\mathop{\\text{rcos}}}\\rcos(\\boldsymbol{x},\\boldsymbol{y})=\\frac{\\boldsymbol{x}\\cdot\\boldsymbol{y}}{\\Vert\\boldsymbol{x}\\Vert\\,\\Vert\\boldsymbol{y}\\Vert}\\end{equation}";
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <span class="MathJax_Preview">不应显示的旧预览</span><script type="math/tex; mode=display">${tex}</script>
        <span id="MathJax-Element-4-Frame" class="MathJax MathJax_Display" alttext="${tex}"><span class="MathJax" data-mathml="&lt;math&gt;不是 TeX&lt;/math&gt;">旧渲染副本</span></span>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex-display")).toHaveLength(1);
    expect(content).toContain("rcos");
    expect(content).not.toContain("不应显示的旧预览");
    expect(content).not.toContain("旧渲染副本");
    expect(content).not.toContain("reader-math-source");
    expect(content).not.toContain("READING_HUB_MATH");
  });

  it("deduplicates a MathJax visual frame when its authored source script follows it", () => {
    const tex = "\\begin{equation}q_i=\\frac{x_i}{y_i}\\end{equation}";
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <span class="MathJax_Display" alttext="${tex}"><span class="MathJax">旧渲染副本</span></span><script type="math/tex; mode=display">${tex}</script>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex-display")).toHaveLength(1);
    expect(content).not.toContain("旧渲染副本");
  });

  it("deduplicates an authored align environment from its MathJax display frame", () => {
    const tex = "\\begin{align}\\text{MoE:}&\\quad d\\to D\\to d\\\\\\text{LatentMoE:}&\\quad d\\to d/2\\to D\\end{align}";
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <script type="math/tex; mode=display">${tex}</script><span class="MathJax_Display" alttext="${tex}"><span class="MathJax">旧渲染副本</span></span>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex-display")).toHaveLength(1);
    expect(content).toContain("LatentMoE");
    expect(content).not.toContain("旧渲染副本");
  });

  it("does not process detached nested MathJax frames a second time", () => {
    const first = "\\begin{equation}a=b\\label{first}\\end{equation}";
    const second = "\\begin{equation}c=d\\label{second}\\end{equation}";
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <span class="MathJax_Display" alttext="${first}"><span class="MathJax" alttext="${first}">嵌套的旧渲染副本</span></span>
        <p>${second}</p>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex-display")).toHaveLength(2);
    expect(content).toContain("(2)");
    expect(content).not.toContain("(3)");
    expect(content).not.toContain("嵌套的旧渲染副本");
  });

  it("prefers an embedded TeX annotation over a MathML metadata attribute", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <mjx-container display="true" data-mathml="&lt;math&gt;&lt;mi&gt;q&lt;/mi&gt;&lt;/math&gt;"><mjx-math><mjx-annotation encoding="application/x-tex">\\boldsymbol{q}=\\frac{\\boldsymbol{x}}{\\Vert\\boldsymbol{x}\\Vert}</mjx-annotation></mjx-math></mjx-container>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex-display")).toHaveLength(1);
    expect(content).toContain('class="katex"');
    expect(content).not.toContain("reader-math-source");
    expect(content).not.toContain("data-mathml");
  });

  it("renders the ranking-similarity Scientific Spaces formula family through one shared macro scope", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <p>对于两个向量$\\boldsymbol{x},\\boldsymbol{y}\\in\\mathbb{R}^d$，定义：</p>
        <p>\\begin{equation}\\cos(\\boldsymbol{x},\\boldsymbol{y}) = \\frac{\\boldsymbol{x}\\cdot\\boldsymbol{y}}{\\Vert\\boldsymbol{x}\\Vert\\,\\Vert\\boldsymbol{y}\\Vert} \\in [-1,1]\\end{equation}</p>
        <p>\\begin{equation}-\\Vert\\boldsymbol{x}\\Vert\\,\\Vert\\boldsymbol{y}\\Vert\\leq\\boldsymbol{x}\\cdot\\boldsymbol{y}\\leq\\Vert\\boldsymbol{x}\\Vert\\,\\Vert\\boldsymbol{y}\\Vert\\end{equation}</p>
        <p>\\begin{equation}\\newcommand{\\rcos}{\\mathop{\\text{rcos}}}\\rcos(\\boldsymbol{x},\\boldsymbol{y}) = \\frac{2\\cdot\\boldsymbol{x}\\cdot\\boldsymbol{y}-\\boldsymbol{x}^{\\uparrow}\\cdot\\boldsymbol{y}^{\\downarrow}-\\boldsymbol{x}^{\\uparrow}\\cdot\\boldsymbol{y}^{\\uparrow}}{\\boldsymbol{x}^{\\uparrow}\\cdot\\boldsymbol{y}^{\\uparrow}-\\boldsymbol{x}^{\\uparrow}\\cdot\\boldsymbol{y}^{\\downarrow}}\\end{equation}</p>
        <p>那么$\\rcos(\\boldsymbol{x},\\boldsymbol{y})=1$，并且</p>
        <p>\\begin{equation}\\rcos(a\\boldsymbol{x}+b\\boldsymbol{1},c\\boldsymbol{y}+d\\boldsymbol{1})=\\rcos(\\boldsymbol{x},\\boldsymbol{y})\\end{equation}</p>
        <p>\\begin{equation}\\mathop{\\text{pearson}}(\\boldsymbol{x},\\boldsymbol{y})=\\cos(\\boldsymbol{x}-\\bar{\\boldsymbol{x}},\\boldsymbol{y}-\\bar{\\boldsymbol{y}})\\end{equation}</p>
        <p>\\begin{equation}\\mathop{\\text{spearman}}(\\boldsymbol{x},\\boldsymbol{y})=\\rcos(\\boldsymbol{r}_x,\\boldsymbol{r}_y)\\end{equation}</p>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    const visible = load(`<article>${content}</article>`);
    visible(".katex, mjx-container, .reader-math-source").remove();
    expect(load(content)(".katex-display")).toHaveLength(6);
    expect(content).not.toContain("katex-error");
    expect(content).not.toContain("reader-math-source");
    expect(visible.text()).not.toMatch(/\\(?:begin|end|newcommand|rcos|boldsymbol|Vert)/);
    expect(content).not.toContain("$\\rcos");
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

  it("processes nested display-math containers once without placeholder cycles", () => {
    const result = extractReaderArticle(
      `<article><p>${"这篇文章用于验证嵌套列表中的块公式只会经过一次语义提取。 ".repeat(24)}</p>
        <ul><li><p>下面两个公式位于同一个嵌套列表项中：</p>
          \\[(\\begin{aligned}q_i &= x_i / y_i\\\\ z_i &= q_i + 1\\end{aligned})\\]
          \\[\\boxed{G_{t:t+n} = R_{t+1} + \\gamma R_{t+2}}\\]
        </li></ul>
        <p>${"列表后的正文必须继续保留。 ".repeat(24)}</p></article>`,
      "https://chizkidd.github.io/2026/03/09/rl-sutton-barto-notes-ch010/",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)("[data-reader-equation]")).toHaveLength(2);
    expect(content).not.toContain("READING_HUB_MATH_");
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 2, text: 2, rendered: 2, fallback: 0, dropped: 0 });
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

  it("ingests Zhihu semantic TeX carriers before their nested MathJax SVG copies are sanitised", () => {
    const result = extractReaderArticle(
      `<html><body><article><div class="Post-RichTextContainer">
        <p>${"知乎专栏的正文用于保证文章根选择与公式语义提取都走真实路径。 ".repeat(24)}</p>
        <span class="ztext-math RichContent-commented-inline" data-tex="\\newcommand{\\rcos}{\\mathop{\\mathrm{rcos}}}\\rcos(\\boldsymbol{x},\\boldsymbol{y})"><span>旧视觉预览</span><span class="MathJax_SVG" id="MathJax-Element-7-Frame"><svg><text>视觉副本</text></svg></span></span>
        <span class="ztext-math RichContent-commented-inline" data-eeimg="2" data-tex="\\rcos(\\boldsymbol{x},\\boldsymbol{y})=\\frac{\\boldsymbol{x}\\cdot\\boldsymbol{y}}{\\lVert\\boldsymbol{x}\\rVert\\,\\lVert\\boldsymbol{y}\\rVert}"><span class="MathJax_SVG" id="MathJax-Element-8-Frame"><svg><text>第二个视觉副本</text></svg></span></span>
        <p>${"后续正文必须在公式后保留，不能被视觉副本或净化流程吞掉。 ".repeat(22)}</p>
      </div></article></body></html>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex")).toHaveLength(2);
    expect(load(content)("[data-reader-equation]")).toHaveLength(1);
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 2, semantic: 2, display: 1, displayRendered: 1, rendered: 2, fallback: 0, dropped: 0 });
    expect(content).toContain("rcos");
    expect(content).not.toContain("ztext-math");
    expect(content).not.toContain("MathJax_SVG");
    expect(content).not.toContain(">视觉副本<");
    expect(content).not.toContain("reader-math-source");
  });

  it("keeps the real Zhihu rcos carrier family on KaTeX when its TeX is supported", async () => {
    const renderAsync = vi.fn(async () => `<mjx-container display="true"><svg viewBox="0 0 12 12"><path d="M0 0h12v12H0z"/></svg></mjx-container>`);
    const math = { isReady: () => true, renderAsync } as unknown as ScientificMathRenderer;
    const result = await extractReaderArticleAsync(
      `<html><body><article><div class="Post-RichTextContainer">
        <p>${"知乎转载的科学文章正文用于验证真实公式结构。 ".repeat(28)}</p>
        <p>定义 <span class="ztext-math" data-eeimg="1" data-tex="\\tilde{rcos}(x,y)"><span class="MathJax_SVG">旧视觉副本</span></span>。</p>
        <span class="ztext-math" data-eeimg="2" data-tex="\\boxed{rcos(x,y) \\approx \\dfrac{\\mathrm{cov}(x,y)}{\\mathrm{cov}(x^\\uparrow,y^\\uparrow)}}"><span class="MathJax_SVG">重复的块公式视觉副本</span></span>
        <p>后续行内公式 <span class="ztext-math" data-eeimg="1" data-tex="\\mathrm{cov}(x^\\uparrow,y^\\uparrow)"><span>旧预览</span></span> 必须保持原本语义。</p>
        <span class="ztext-math" data-eeimg="2" data-tex="\\begin{aligned}x^\\uparrow_i &\\approx Q(p)=F^{-1}(p)\\\\Q(p) &\\approx \\mu + \\sigma\\xi_p\\end{aligned}"></span>
        <p>${"公式后的作者正文必须完整保留。 ".repeat(24)}</p>
      </div></article></body></html>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry,
      math
    );

    const content = result?.article.contentHtml || "";
    const visible = load(`<article>${content}</article>`);
    visible("mjx-container, .katex, .reader-math-source").remove();
    expect(load(content)("[data-reader-equation]")).toHaveLength(2);
    expect(load(content)(".katex")).toHaveLength(4);
    expect(content).not.toContain("reader-equation--mathjax");
    expect(content).not.toContain("mjx-merror");
    expect(content).not.toContain("READING_HUB_MATH");
    expect(content).not.toContain("旧视觉副本");
    expect(visible.text()).not.toMatch(/\\(?:tilde|mathrm|dfrac|begin|end)/);
    expect(result?.article.formulaDiagnostics).toMatchObject({
      total: 4,
      semantic: 4,
      display: 2,
      displayRendered: 2,
      rendered: 4,
      fallback: 0,
      dropped: 0
    });
    expect(renderAsync).not.toHaveBeenCalled();
  });

  it("keeps macro declarations ordered instead of applying a later redefinition retroactively", () => {
    const render = vi.fn(() => `<mjx-container><svg></svg></mjx-container>`);
    const math = { isReady: () => true, render } as unknown as ScientificMathRenderer;
    extractReaderArticle(
      `<article><div class="Post-RichTextContainer"><p>${"正文。".repeat(80)}</p>
        <span class="ztext-math" data-eeimg="1" data-tex="\\newcommand{rcos}{\\mathrm{first}}\\mathjaxOnlyCommand{\\rcos}"></span>
        <span class="ztext-math" data-eeimg="1" data-tex="\\renewcommand{rcos}{\\mathrm{second}}\\mathjaxOnlyCommand{\\rcos}"></span>
      </div></article>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry,
      math
    );

    expect(render).toHaveBeenNthCalledWith(1, "\\mathjaxOnlyCommand{\\rcos}", false, expect.objectContaining({ rcos: expect.objectContaining({ body: "\\mathrm{first}" }) }));
    expect(render).toHaveBeenNthCalledWith(2, "\\mathjaxOnlyCommand{\\rcos}", false, expect.objectContaining({ rcos: expect.objectContaining({ body: "\\mathrm{second}" }) }));
  });

  it("parses nested MathJax config macros without executing page JavaScript", () => {
    const result = extractReaderArticle(
      `<html><head><script type="text/x-mathjax-config">
        MathJax.Hub.Config({ TeX: { Macros: {
          rcos: ["\\\\mathop{\\\\mathrm{rcos}}", 0],
          rnorm: ["\\\\left\\\\lVert#1\\\\right\\\\rVert", 1]
        } } });
      </script></head><body><article><p>函数 $\\rcos(x,y)$ 的范数为 $\\rnorm{\\boldsymbol{x}}$。${"额外正文用于避免短文筛选。 ".repeat(34)}</p></article></body></html>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex")).toHaveLength(2);
    expect(content).toContain("rcos");
    expect(content).not.toContain("reader-math-source");
    expect(content).not.toContain("$\\rcos");
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 2, rendered: 2, fallback: 0, dropped: 0 });
  });

  it("uses the local MathJax SVG fallback for a Zhihu formula regardless of the page render profile", () => {
    const render = vi.fn(() => `<mjx-container display="true"><svg viewBox="0 0 12 12"><path d="M0 0h12v12H0z"/></svg></mjx-container>`);
    const math = { isReady: () => true, render } as unknown as ScientificMathRenderer;
    const result = extractReaderArticle(
      `<article><div class="Post-RichTextContainer">
        <p>${"知乎转载的科学文章正文。 ".repeat(36)}</p>
        <span class="ztext-math ztext-math-block" data-eeimg="1" data-tex="\\mathjaxOnlyCommand{\\boldsymbol{x}}"><span class="MathJax_SVG"><svg><text>旧视觉副本</text></svg></span></span>
        <p>${"公式后的正文仍应可读。 ".repeat(30)}</p>
      </div></article>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry,
      math
    );

    expect(render).toHaveBeenCalledWith("\\mathjaxOnlyCommand{\\boldsymbol{x}}", true, expect.any(Object));
    expect(result?.article.contentHtml).toContain("reader-equation--mathjax");
    expect(result?.article.contentHtml).toContain("mjx-container");
    expect(result?.article.contentHtml).not.toContain("reader-math-source");
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 1, semantic: 1, rendered: 1, fallback: 0, dropped: 0 });
  });

  it("lazily starts the MathJax fallback after a standard-profile article actually needs it", async () => {
    let ready = false;
    const render = vi.fn(() => `<mjx-container display="true"><svg viewBox="0 0 12 12"><path d="M0 0h12v12H0z"/></svg></mjx-container>`);
    const math = {
      isReady: () => ready,
      ready: vi.fn(async () => { ready = true; }),
      render
    } as unknown as ScientificMathRenderer;
    const http = {
      getText: vi.fn(async () => ({
        url: entry.url,
        contentType: "text/html",
        text: `<article><p>${"标准来源正文。 ".repeat(40)}</p><p>$$\\mathjaxOnlyCommand{\\boldsymbol{x}}$$</p><p>${"后续正文。 ".repeat(36)}</p></article>`
      }))
    } as unknown as PublicHttpClient;
    const reader = new ArticleReader(http, { render: async () => "" }, undefined, math);

    const article = await reader.read(entry);

    expect(math.ready).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith("\\mathjaxOnlyCommand{\\boldsymbol{x}}", true, expect.any(Object));
    expect(article.contentHtml).toContain("reader-equation--mathjax");
    expect(article.formulaDiagnostics).toMatchObject({ total: 1, rendered: 1, fallback: 0, dropped: 0 });
  });

  it("does not start MathJax merely because a Zhihu carrier supplies semantic TeX", async () => {
    let ready = false;
    const render = vi.fn(() => `<mjx-container><svg viewBox="0 0 12 12"><path d="M0 0h12v12H0z"/></svg></mjx-container>`);
    const math = {
      isReady: () => ready,
      ready: vi.fn(async () => { ready = true; }),
      render
    } as unknown as ScientificMathRenderer;
    const http = {
      getText: vi.fn(async () => ({
        url: "https://zhuanlan.zhihu.com/p/2073205832964220804",
        contentType: "text/html",
        text: `<article><div class="Post-RichTextContainer"><p>${"知乎正文。 ".repeat(48)}</p><span class="ztext-math" data-eeimg="2" data-tex="\\boxed{rcos(x,y)=\\frac{\\mathrm{cov}(x,y)}{\\mathrm{cov}(x^\\uparrow,y^\\uparrow)}}"></span><p>${"公式后的正文。 ".repeat(34)}</p></div></article>`
      }))
    } as unknown as PublicHttpClient;
    const reader = new ArticleReader(http, { render: async () => "" }, undefined, math);

    const article = await reader.read({ ...entry, url: "https://zhuanlan.zhihu.com/p/2073205832964220804" });

    expect(math.ready).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(article.contentHtml).toContain('class="katex"');
    expect(article.contentHtml).not.toContain("reader-equation--mathjax");
    expect(article.formulaDiagnostics).toMatchObject({ total: 1, semantic: 1, rendered: 1, fallback: 0, dropped: 0 });
  });

  it("does not let a predictable-looking remote token duplicate a generated formula anchor", () => {
    const result = extractReaderArticle(
      `<article><p>[[READING_HUB_MATH_1_0]] 与 $x^\\uparrow$ 都是正文的一部分。${"额外正文。 ".repeat(42)}</p></article>`,
      entry.url,
      entry
    );

    expect(load(result?.article.contentHtml || "")(".katex")).toHaveLength(1);
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 1, rendered: 1, fallback: 0, dropped: 0 });
  });

  it("keeps explicit equation tags authoritative and resolves references through the same equation index", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(24)}</p>
        <p>\\begin{equation}\\cos(\\boldsymbol{x},\\boldsymbol{y})=1\\tag{13}\\label{eq:rcos}\\end{equation}</p>
        <p>由公式 $\\eqref{eq:rcos}$ 可知这个相似度的上界。${"后续正文。 ".repeat(36)}</p>
      </article>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry
    );

    const content = result?.article.contentHtml || "";
    const document = load(content);
    expect(document("[data-reader-equation] .reader-equation__tag").text()).toBe("(13)");
    expect(content).toContain("(13)");
    expect(content).not.toContain("reader-equation__tag\" aria-label=\"公式编号\">(1)");
    expect(content).not.toContain("\\label{");
    expect(content).not.toContain("\\tag{");
    expect(content).not.toContain("reader-math-source");
  });

  it("keeps multi-row Zhihu tags inside the scientific formula document instead of adding an overlapping reader tag", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = await extractReaderArticleAsync(
      `<article><div class="Post-RichTextContainer">
        <p>${"知乎转载的数学正文用于验证多行公式、编号和引用遵循同一文档语义。 ".repeat(24)}</p>
        <script type="math/tex">\\newcommand{\\rcos}{\\operatorname{rcos}}</script>
        <script type="math/tex; mode=display">\\begin{align}
          \\rcos(\\boldsymbol{x},\\boldsymbol{y}) &= 1 \\tag{13}\\label{eq:rcos}\\\\
          \\rcos(\\boldsymbol{x},-\\boldsymbol{y}) &= -1 \\tag{14}\\label{eq:anti-rcos}
        \\end{align}</script>
        <p>由公式 $\\eqref{eq:rcos}$ 可知该相似度的边界。${"后续作者正文仍要完整保留。 ".repeat(24)}</p>
      </div></article>`,
      "https://zhuanlan.zhihu.com/p/2073205832964220804",
      entry,
      math
    );

    const content = result?.article.contentHtml || "";
    const document = load(content);
    const nonFormula = load(`<article>${content}</article>`);
    nonFormula("mjx-container, .reader-math-source").remove();
    expect(result?.article.formulaDiagnostics).toMatchObject({
      total: 3,
      display: 1,
      rendered: 3,
      fallback: 0,
      dropped: 0,
      formulaRenderPolicy: "scientific-document"
    });
    expect(document("[data-reader-equation]")).toHaveLength(1);
    expect(document(".reader-equation--mathjax.reader-equation--native-tags")).toHaveLength(1);
    expect(document(".reader-equation__tag")).toHaveLength(0);
    expect(content).toContain("mjx-container");
    expect(content).not.toMatch(/\\(?:begin|end|tag|label|eqref|rcos)/);
    expect(nonFormula.text()).toContain("由公式");
  });

  it("replays lost zero-arity custom operators from a post-typeset Scientific Spaces snapshot", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <p>后渲染页面只保留 $\\recos(\\boldsymbol{x},\\boldsymbol{y}) = \\frac{\\boldsymbol{x}\\cdot\\boldsymbol{y}}{\\Vert\\boldsymbol{x}\\Vert\\,\\Vert\\boldsymbol{y}\\Vert}$，但原始的 newcommand 声明已经不存在。</p>
        <p>${"该公式应继续作为正常的数学运算符显示。 ".repeat(26)}</p>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    const visible = load(`<article>${content}</article>`);
    visible(".katex, mjx-container, .reader-math-source").remove();
    expect(visible.text()).not.toContain("\\recos");
    expect(content).toContain('class="katex"');
    expect(content).not.toContain("reader-math-source");
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 1, rendered: 1, fallback: 0, dropped: 0 });
  });

  it("does not guess an unknown command with arguments as a lost operator", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <p>无法确认语义的公式是 $\\unknownoperator{\\boldsymbol{x}}$。</p>
        <p>${"这段后续正文用于保持文章提取质量。 ".repeat(26)}</p>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    expect(result?.article.contentHtml).toContain("reader-math-source");
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 1, rendered: 0, fallback: 1, dropped: 0 });
  });

  it("applies macro declarations in final DOM order when source carriers are extracted in separate passes", () => {
    const result = extractReaderArticle(
      `<article><p>${"用于保证正文提取稳定的说明文字。 ".repeat(26)}</p>
        <script type="math/tex">\\newcommand{\\recos}{\\operatorname{recos}}</script>
        <p>随后出现的语义公式是 <span data-reader-tex="\\recos(\\boldsymbol{x})"></span>。</p>
        <p>${"该声明必须先于实际公式生效。 ".repeat(26)}</p>
      </article>`,
      "https://kexue.fm/archives/11818",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content)(".katex")).toHaveLength(1);
    expect(content).not.toContain("reader-math-source");
    expect(result?.article.formulaDiagnostics).toMatchObject({ total: 2, rendered: 2, fallback: 0, dropped: 0 });
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

  it("keeps MathJax 4 multi-SVG break fragments in a safe local formula", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();

    // MathJax 4 emits this expression as two SVG glyph runs separated by an
    // inert `<mjx-break>` marker. It is a normal renderer output, not source
    // HTML, and must not make an entire scientific document fall back.
    const rendered = await math.renderAsync("\\boldsymbol{x},\\boldsymbol{y}\\in\\mathbb{R}^d", false, {});

    expect(rendered).toContain("<mjx-break size=\"4\"> ");
    expect(rendered?.match(/<svg\b/g)?.length).toBe(2);
    expect(rendered).not.toMatch(/(?:data-|on\w+=|javascript:)/i);
  });

  it("removes unsafe MathJax links from remote TeX and macro output", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const rendered = await Promise.all([
      math.renderAsync("\\href{javascript:alert(1)}{x}", false, {}),
      math.renderAsync("\\unsafe{y}", false, {
        unsafe: { body: "\\href{javascript:alert(1)}{#1}", argumentCount: 1 }
      })
    ]);

    for (const svg of rendered) {
      expect(svg).toContain("<mjx-container");
      // Links in MathJax SVG are deliberately flattened to glyphs. Only
      // fragment references required by <use> may remain in the SVG graph.
      expect(svg).not.toMatch(/<a\b|(?:javascript|data):/i);
      expect(svg).not.toMatch(/(?:href|xlink:href)="(?:https?:|javascript:|data:)/i);
      expect(svg).not.toMatch(/\s(?:on\w+|data-[\w-]+)=/i);
      for (const [, style] of svg.matchAll(/\sstyle="([^"]*)"/g)) {
        expect(style).toMatch(/^vertical-align: -?(?:\d+(?:\.\d+)?|\.\d+)(?:ex|em|px);$/);
      }
      expect(svg).toMatch(/xlink:href="#MJX-/);
    }
  });

  it("keeps only local MathJax SVG glyph references and rejects active SVG nodes", () => {
    const safe = sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow" width="full"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1ex" height="1ex" viewBox="0 0 10 10" role="img" focusable="false" style="vertical-align:-0.02ex">
        <defs><path id="MJX-safe" d="M0 0L10 10" style="stroke-width:.06ex"/><path id="MJX-empty" d=""/></defs><g fill="currentColor"><use xlink:href="#MJX-safe"/></g>
      </svg></mjx-container>
    `) || "";
    expect(safe).toContain('xlink:href="#MJX-safe"');
    expect(safe).toContain('width="full"');
    expect(safe).toContain('id="MJX-empty" d=""');
    expect(safe).toContain('style="vertical-align: -0.02ex;"');
    expect(safe).toContain('style="stroke-width: .06ex;"');

    const stripped = sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1ex" height="1ex" viewBox="0 0 10 10" role="img" focusable="false" onload="alert(1)" style="position:fixed">
        <defs><path id="MJX-safe" d="M0 0L10 10" onclick="alert(1)"/></defs><g><use xlink:href="#MJX-safe"/></g>
      </svg></mjx-container>
    `) || "";
    expect(stripped).not.toMatch(/(?:javascript:|onload=|onclick=|style=)/i);

    expect(sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1ex" height="1ex" viewBox="0 0 10 10">
        <defs><path id="MJX-safe" d="M0 0L10 10"/></defs><use xlink:href="javascript:alert(1)"/><use xlink:href="#MJX-missing"/>
      </svg></mjx-container>
    `)).toBeUndefined();

    expect(sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow"><svg xmlns="http://www.w3.org/2000/svg" width="1ex" height="1ex" viewBox="0 0 10 10">
        <foreignObject><script>alert(1)</script></foreignObject>
      </svg></mjx-container>
    `)).toBeUndefined();

    // A MathJax 4 line-break marker is accepted only as a direct,
    // whitespace-only sibling of SVG output. It cannot carry a nested
    // active subtree into the reader.
    expect(sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow"><svg xmlns="http://www.w3.org/2000/svg" width="1ex" height="1ex" viewBox="0 0 10 10"></svg>
        <mjx-break size="4"><script>alert(1)</script></mjx-break>
      </mjx-container>
    `)).toBeUndefined();

    // An older MathJax `noundefined` result is syntactically safe SVG but is
    // semantically an error: the red mtext represents a bare unknown command.
    expect(sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow"><svg xmlns="http://www.w3.org/2000/svg" width="1ex" height="1ex" viewBox="0 0 10 10">
        <g data-mml-node="mtext" data-latex="\\recos" fill="red" stroke="red"><text>recos</text></g>
      </svg></mjx-container>
    `)).toBeUndefined();

    // Red is a valid author-selected math colour. It must not be rejected
    // unless it carries the exact noundefined mtext signature above.
    expect(sanitizeMathJaxSvg(`
      <mjx-container class="MathJax" jax="SVG" overflow="overflow"><svg xmlns="http://www.w3.org/2000/svg" width="1ex" height="1ex" viewBox="0 0 10 10">
        <g data-mml-node="mstyle" fill="red" stroke="red"><text>x</text></g>
      </svg></mjx-container>
    `)).toContain("<text>x</text>");
  });

  it("rejects MathJax's unknown-command output instead of returning red error glyphs", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();

    await expect(math.renderAsync("\\unknowncommand{x}", false, {})).resolves.toBeUndefined();
    await expect(math.renderAsync("\\recos(\\boldsymbol{x},\\boldsymbol{y})", false, {})).resolves.toBeUndefined();
    await expect(math.renderAsync("\\begin{notanenvironment}x\\end{notanenvironment}", true, {})).resolves.toBeUndefined();
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

  it("renders a Scientific Spaces formula document through one MathJax path without duplicate previews or title anchors", async () => {
    const math = new ScientificMathRenderer();
    await math.ready();
    const result = await extractReaderArticleAsync(
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
    expect(result?.article.formulaDiagnostics?.formulaRenderPolicy).toBe("scientific-document");
    expect(content).toContain("reader-equation--mathjax");
    expect(content).toContain("mjx-container");
    expect(content).not.toContain('class="katex"');
    expect(content).not.toContain("预览副本");
    expect(content).not.toContain("READING_HUB_MATH");
    expect(visible.text()).not.toContain("\\begin{align}");
    expect(content).not.toContain("mjx-merror");
    expect(content).not.toContain("mjx-spacer");
    expect(content).not.toContain("Norm #");
    expect(content).not.toContain("首页 数学研究 信息时代");
    expect(content).not.toContain("By 苏剑林");
  });

  it("removes Scientific Spaces discussion markup before a split comment formula reaches the reader", () => {
    const result = extractReaderArticle(
      `<html><body><div id="content">
        <h1>基于排序不等式的相似度指标</h1>
        <p>文章的真实第一段正文，应该被阅读器完整保留。${"后续正文。".repeat(58)}</p>
        <section id="comments"><div class="AllComments"><article class="ComListLi">
          <p>评论中的拆分公式：$\\tilde{rcos}\\to\\dfrac{2S_{xy}}{D_{xy}}=\\dfrac{cov(x,y<span>}{\\mathrm{cov}(x^\\uparrow,y^\\uparrow)}</span>$</p>
        </article></div></section>
        <section id="PostComment"><div class="block-comment"><p>渲染页中的评论也不应进入正文。</p></div></section>
      </div></body></html>`,
      "https://kexue.fm/archives/11818",
      { ...entry, summary: "文章的真实第一段正文，应该被阅读器完整保留。" }
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain("文章的真实第一段正文");
    expect(content).not.toContain("评论中的拆分公式");
    expect(content).not.toContain("渲染页中的评论");
    expect(content).not.toContain("tilde{rcos}");
    expect(content).not.toContain("reader-math-source");
    expect(content).not.toContain("READING_HUB_MATH");
  });

  it("prefers Scientific Spaces' dedicated post container over the page-wide content shell", () => {
    const result = extractReaderArticle(
      `<html><body><div id="content">
        <nav>首页 / 数学研究</nav>
        <article id="PostContent" class="PostContent">
          <h1>基于排序不等式的相似度指标</h1>
          <p>文章的真实第一段正文，应该被阅读器完整保留。${"后续正文。".repeat(58)}</p>
          <p>设 $q_i = x_i / y_i$，这是正文中的行内公式。</p>
        </article>
        <section id="comments"><p>评论区与 $\\tilde{rcos}$ 不应进入正文。</p></section>
        <section id="pay"><p>付款二维码不应进入正文。</p></section>
        <section id="how_to_cite"><p>引用小工具不应进入正文。</p></section>
      </div></body></html>`,
      "https://kexue.fm/archives/11818",
      { ...entry, summary: "文章的真实第一段正文，应该被阅读器完整保留。" }
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain("文章的真实第一段正文");
    expect(load(content)(".katex")).toHaveLength(1);
    expect(content).not.toMatch(/首页|评论区|付款二维码|引用小工具|tilde\{rcos\}/);
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

  it("switches only to a short-lived, author-declared language variant", async () => {
    const englishUrl = "https://xihuai18.github.io/reinforcement-learning/2025/12/01/kl-estimators-en.html";
    const chineseUrl = "https://xihuai18.github.io/reinforcement-learning/2025/12/01/kl-estimators-zh.html";
    const bilingualEntry: Entry = { ...entry, url: englishUrl, canonicalUrl: englishUrl };
    const getText = vi.fn(async (url: string) => {
      if (url === englishUrl) {
        return {
          url: englishUrl,
          text: `<html lang="en"><body><article><header><h1>KL estimators</h1><a href="${chineseUrl}">中文版本 →</a></header><p>${"English body. ".repeat(40)}</p></article></body></html>`
        };
      }
      if (url === chineseUrl) {
        return {
          url: chineseUrl,
          text: `<html lang="zh-CN"><body><article><header><h1>KL 估计量</h1><a href="${englishUrl}">English Version →</a></header><p>${"中文正文。".repeat(80)}</p></article></body></html>`
        };
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const reader = new ArticleReader(
      { getText } as unknown as PublicHttpClient,
      { render: async () => { throw new Error("renderer must not be used"); } }
    );

    const initial = await reader.read(bilingualEntry);
    const switched = await reader.readLanguageVariant(bilingualEntry, undefined, chineseUrl);

    expect(initial.activeLanguage).toBe("en");
    expect(switched.url).toBe(chineseUrl);
    expect(switched.title).toBe("KL 估计量");
    expect(switched.activeLanguage).toBe("zh");
    expect(switched.languageVariants).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: englishUrl, language: "en" }),
      expect.objectContaining({ url: chineseUrl, language: "zh" })
    ]));
    const callsBeforeRejectedSwitch = getText.mock.calls.length;
    await expect(reader.readLanguageVariant(bilingualEntry, undefined, "https://untrusted.example/translation")).rejects.toThrow("语言版本已过期或不可用");
    expect(getText).toHaveBeenCalledTimes(callsBeforeRejectedSwitch);
  });

  it("propagates an audit cancellation to the active fetch and does not enter renderer fallback", async () => {
    const controller = new AbortController();
    let requestedSignal: AbortSignal | undefined;
    let rendererCalled = false;
    const http = {
      getText: (_url: string, _cached?: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        requestedSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      })
    } as unknown as PublicHttpClient;
    const renderer: PageRenderer = {
      render: async () => {
        rendererCalled = true;
        return "";
      }
    };

    const reading = new ArticleReader(http, renderer).read(entry, undefined, { signal: controller.signal });
    expect(requestedSignal).toBe(controller.signal);
    controller.abort(new Error("审计已取消"));

    await expect(reading).rejects.toThrow("审计已取消");
    expect(rendererCalled).toBe(false);
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

  it("uses a supplied RSS body when an otherwise public original page temporarily rejects the reader", async () => {
    const source: Source = {
      id: "feed-source", url: "https://example.com/feed.xml", title: "Example Feed", kind: "rss", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };
    const requests: string[] = [];
    const http = {
      getText: async (url: string) => {
        requests.push(url);
        if (url === entry.url) throw new Error("请求失败（HTTP 403）");
        if (url === source.url) return {
          url: source.url,
          status: 200,
          contentType: "application/rss+xml",
          text: `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example</title><item><title>示例文章</title><link>${entry.url}</link><content:encoded><![CDATA[<p>Feed 已明确提供的正文，在原页临时不可读时仍可安全显示。</p><script>alert(1)</script>]]></content:encoded></item></channel></rss>`
        };
        throw new Error("不应请求其他地址");
      }
    } as unknown as PublicHttpClient;
    const reader = new ArticleReader(http, { render: async () => { throw new Error("渲染也不可用"); } });

    const article = await reader.read(entry, source);

    expect(article.contentMode).toBe("feed_body");
    expect(article.contentHtml).toContain("Feed 已明确提供的正文");
    expect(article.contentHtml).not.toContain("script");
    expect(requests).toEqual([entry.url, source.url]);
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

  it("keeps annotated Zhihu RichContent text while excluding its page-level discussion thread", () => {
    const result = extractReaderArticle(
      `<article class="QuestionAnswer-content">
        <div class="RichContent-inner">
          <p>${"知乎正文内容 ".repeat(24)}</p>
          <p>这段<span class="RichContent-commented-inline">被评论标注的文字</span>仍是作者正文，必须保留。</p>
          <a class="CommentLink" href="#comments">3 条评论</a>
          <section class="CommentList"><article class="CommentItem"><p><span class="RichContent-commented-inline">底部评论区不应进入正文。</span></p></article></section>
        </div>
      </article>`,
      "https://www.zhihu.com/question/123/answer/456",
      entry
    );

    expect(result?.article.contentHtml).toContain("被评论标注的文字");
    expect(result?.article.contentHtml).not.toContain("3 条评论");
    expect(result?.article.contentHtml).not.toContain("底部评论区");
  });

  it("retains authored text wrapped by Zhihu's line-comment control without keeping the control itself", () => {
    const result = extractReaderArticle(
      `<article class="QuestionAnswer-content">
        <div class="RichContent-inner">
          <p>${"知乎正文内容 ".repeat(24)}</p>
          <p>前文<a class="CommentLink" href="#comments">被评论的<strong>作者原句</strong></a>后文。</p>
          <div class="RichContent-commented">另一段被实验标记的作者正文仍应完整显示。</div>
          <a class="CommentLink" href="#comments">查看 8 条评论</a>
          <section class="CommentsV2"><article class="CommentItem"><p><span class="RichContent-commented-inline">评论者文字绝不能混入正文。</span></p></article></section>
        </div>
      </article>`,
      "https://www.zhihu.com/question/123/answer/456",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content).text().replace(/\s+/g, "")).toContain("前文被评论的作者原句后文");
    expect(content).toContain("另一段被实验标记的作者正文仍应完整显示");
    expect(content).not.toContain("查看 8 条评论");
    expect(content).not.toContain("评论者文字绝不能混入正文");
    expect(content).not.toContain('href="https://www.zhihu.com/question/123/answer/456#comments"');
    expect(content).not.toMatch(/RichContent-commented|CommentLink/);
  });

  it("keeps lower-camel Zhihu line-comment markup without relying on a class-name whitelist", () => {
    const result = extractReaderArticle(
      `<article class="QuestionAnswer-content">
        <div class="RichContent-inner">
          <p>${"知乎正文内容 ".repeat(24)}</p>
          <p>开头<a class="RichContent-commentLink" href="#comment-123">被读者评论的作者原句</a>结尾。</p>
          <p>另一处<span class="ContentItem-commentHighlight">带新实验类名的作者正文</span>也必须保留。</p>
          <p>还有<button class="CommentContent-highlight" type="button">可点击批注中的作者原句</button>。</p>
          <button class="ContentItem-commentHighlight" type="button">写评论</button>
          <a class="RichContent-commentLink" href="#comments">查看 12 条评论</a>
          <section class="CommentList"><article class="CommentItem"><p>底部讨论区绝不能进入正文。</p></article></section>
        </div>
      </article>`,
      "https://zhuanlan.zhihu.com/p/123456",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content).text().replace(/\s+/g, "")).toContain("开头被读者评论的作者原句结尾");
    expect(content).toContain("带新实验类名的作者正文");
    expect(content).toContain("可点击批注中的作者原句");
    expect(content).not.toContain("写评论");
    expect(content).not.toContain("查看 12 条评论");
    expect(content).not.toContain("底部讨论区绝不能进入正文");
    expect(content).not.toMatch(/commentLink|commentHighlight|CommentList|CommentItem/);
  });

  it("distinguishes an inline Zhihu CommentItem annotation from a block discussion record", () => {
    const result = extractReaderArticle(
      `<article class="QuestionAnswer-content">
        <div class="RichContent-inner">
          <p>${"知乎正文内容 ".repeat(24)}</p>
          <p>前文<span class="CommentItem CommentItemV2">被读者评论但仍属于作者的原句</span>后文。</p>
          <section class="CommentList"><article class="CommentItem"><p>真正的评论区文字绝不能混入正文。</p></article></section>
        </div>
      </article>`,
      "https://www.zhihu.com/question/123/answer/456",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(load(content).text().replace(/\s+/g, "")).toContain("前文被读者评论但仍属于作者的原句后文");
    expect(content).not.toContain("真正的评论区文字绝不能混入正文");
    expect(content).not.toMatch(/CommentItem/);
  });

  it("keeps a block-wrapped Zhihu line annotation inside RichContent while excluding its discussion tree", () => {
    const result = extractReaderArticle(
      `<article class="QuestionAnswer-content">
        <div class="RichContent-inner">
          <p>${"知乎正文内容 ".repeat(24)}</p>
          <div class="CommentItem RichContent-commented">这个块级包装的被评论作者段落仍然必须显示。</div>
          <article class="CommentItem"><p>没有列表容器的真实评论记录仍然不能进入正文。</p></article>
          <section class="CommentList"><article class="CommentItem"><p>真正的讨论记录绝不能进入正文。</p></article></section>
        </div>
      </article>`,
      "https://www.zhihu.com/question/123/answer/456",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain("这个块级包装的被评论作者段落仍然必须显示");
    expect(content).not.toContain("没有列表容器的真实评论记录");
    expect(content).not.toContain("真正的讨论记录绝不能进入正文");
    expect(content).not.toMatch(/CommentItem|RichContent-commented/);
  });

  it("preserves a nested block CommentItem when an authored Zhihu annotation owns the subtree", () => {
    const result = extractReaderArticle(
      `<article class="QuestionAnswer-content">
        <div class="Post-RichTextContainer">
          <p>${"知乎正文内容 ".repeat(24)}</p>
          <div class="RichContent-commented"><div class="CommentItem"><blockquote>被读者评论的整段作者文字仍然必须显示。</blockquote></div></div>
          <section class="CommentList"><article class="CommentItem"><p>真正的评论区文字绝不能混入正文。</p></article></section>
        </div>
      </article>`,
      "https://zhuanlan.zhihu.com/p/123456",
      entry
    );

    const content = result?.article.contentHtml || "";
    expect(content).toContain("被读者评论的整段作者文字仍然必须显示");
    expect(content).not.toContain("真正的评论区文字绝不能混入正文");
    expect(content).not.toMatch(/RichContent-commented|CommentItem|CommentList/);
  });

  it("uses the authorised Zhihu reading path for line-comment annotations", async () => {
    const http = {
      getText: async () => { throw new Error("公开 HTTP 不应被调用"); }
    } as unknown as PublicHttpClient;
    const source: Source = {
      id: "zhihu-source", url: "https://www.zhihu.com/follow", title: "知乎关注动态", kind: "zhihu_follow", status: "active",
      pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
    };
    const reader = new ArticleReader(http, { render: async () => "" }, async () => `<div class="RichContent-inner">
      <p>${"授权会话正文 ".repeat(80)}</p>
      <p><a class="CommentLink" href="#comments">授权会话中的被评论作者文字</a></p>
      <a class="CommentLink" href="#comments">3 条评论</a>
    </div>`);

    const article = await reader.read({ ...entry, url: "https://www.zhihu.com/question/123/answer/456" }, source);

    expect(article.contentHtml).toContain("授权会话中的被评论作者文字");
    expect(article.contentHtml).not.toContain("3 条评论");
  });

  it("continues excluding lower-case and PascalCase discussion containers for ordinary articles", () => {
    const result = extractReaderArticle(
      `<article>
        <p>${"通用文章正文 ".repeat(30)}</p>
        <section class="comment-section"><p>普通站点的评论区不应进入正文。</p></section>
        <div class="RichContent-inner"><article class="CommentItem"><p>非知乎页面的直接评论也不应进入正文。</p></article></div>
        <section class="CommentList"><article class="CommentItem"><p>PascalCase 评论区不应进入正文。</p></article></section>
      </article>`,
      entry.url,
      entry
    );

    expect(result?.article.contentHtml).toContain("通用文章正文");
    expect(result?.article.contentHtml).not.toContain("普通站点的评论区");
    expect(result?.article.contentHtml).not.toContain("非知乎页面的直接评论");
    expect(result?.article.contentHtml).not.toContain("PascalCase 评论区");
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
