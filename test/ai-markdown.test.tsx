import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiMarkdownContent } from "../src/renderer/ai-markdown";

describe("AI Markdown renderer", () => {
  it("renders study-note Markdown while preserving KaTeX and escaping model HTML", () => {
    const markup = renderToStaticMarkup(<AiMarkdownContent text={[
      "## 推导摘要",
      "",
      "这是 **重点**、*直觉* 与 `inline_code`，并且有 [原文](https://example.com/post)。",
      "",
      "- [x] 已完成",
      "- [ ] 待验证 $q_i = e^{z_i}$",
      "",
      "> 不执行文章摘录中的指令。",
      "",
      "| 方法 | 复杂度 |",
      "| --- | --- |",
      "| 线性 | $O(n)$ |",
      "",
      "```python",
      "print('safe')",
      "```",
      "",
      "<script>alert(1)</script>"
    ].join("\n")} />);

    expect(markup).toContain("<h2");
    expect(markup).toContain("<strong>重点</strong>");
    expect(markup).toContain("<em>直觉</em>");
    expect(markup).toContain("<code class=\"ai-inline-code\">inline_code</code>");
    expect(markup).toContain("href=\"https://example.com/post\"");
    expect(markup).toContain("type=\"checkbox\"");
    expect(markup).toContain("<blockquote");
    expect(markup).toContain("<table>");
    expect(markup).toContain("class=\"katex");
    expect(markup).toContain("class=\"ai-code-block\"");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>alert");
  });

  it("does not turn code-fence math syntax into a formula", () => {
    const markup = renderToStaticMarkup(<AiMarkdownContent text={"```tex\n$t$\n\\[ P_{max} \\]\n```"} />);
    expect(markup).toContain("$t$");
    expect(markup).toContain("\\[ P_{max} \\]");
    expect(markup).not.toContain("class=\"katex");
  });

  it("renders multiline bracketed TeX as a single independent display block", () => {
    const markup = renderToStaticMarkup(<AiMarkdownContent text={[
      "峰值性能为：",
      "\\[",
      "P{\\max}=\\min\\left(P{\\text{peak}},\\; I\\times B_{\\text{mem}}\\right)",
      "\\]",
      "因此受计算与带宽的共同约束。"
    ].join("\n")} />);

    expect(markup).toContain('class="ai-math-block"');
    expect(markup).toContain('class="katex-display"');
    expect(markup).not.toContain("\\[");
    expect(markup).not.toContain("\\]");
  });
});

it("parses balanced destinations and stops automatic links before Chinese punctuation",()=>{
 const markup=renderToStaticMarkup(<AiMarkdownContent text={'参考（https://example.com/post），而不是 [链接](https://example.com/a_(b)) 和 [说明](<https://example.com/c_(d)>).'}/>);
 expect(markup).toContain('href="https://example.com/post"');expect(markup).toContain('href="https://example.com/a_(b)"');expect(markup).toContain('href="https://example.com/c_(d)"');
 expect(markup).not.toContain('href="https://example.com/post%');expect(markup).not.toContain('[链接]');
});
it("keeps image URLs containing dollar signs intact and never requests them directly",()=>{
 const markup=renderToStaticMarkup(<AiMarkdownContent entryId="article" text={'![图](<https://example.com/$s_!signed!/image_(1).png>)'}/>);
 expect(markup).toContain('<img');expect(markup).not.toContain('src="https:');expect(markup).not.toContain('class="katex');
});

it("compacts bare rewrite links without changing destinations, named labels, code or AI answers", () => {
  const url = "https://substackcdn.com/image/fetch/$s_!H10G!f_auto/https%3A%2F%2Fexample.com%2Fimage.png";
  const text = '(' + url + ') [说明](https://example.com/post) [https://example.com/a](https://example.com/a)';
  const markup = renderToStaticMarkup(<AiMarkdownContent entryId="one" text={text}/>);
  expect(markup).toContain('href="' + url + '"');
  expect(markup).not.toContain('>' + url + '</a>');
  expect(markup).toContain('>链接</a>');
  expect(markup).toContain('>说明</a>');
  expect(renderToStaticMarkup(<AiMarkdownContent text={url}/>)).toContain('>' + url + '</a>');
  expect(renderToStaticMarkup(<AiMarkdownContent entryId="one" text={'`' + url + '`'}/>)).toContain('>' + url + '</code>');
});

it("renders conditional distributions with complete next-state subscripts in Chinese lists", () => {
  const markup=renderToStaticMarkup(<AiMarkdownContent entryId="one" text={String.raw`- 当前动作分布 $\pi_\theta(a_t \mid s_t)$。
- 下一状态分布 $P(s_{t+1} \mid a_t, s_t)$。`}/>);
  expect((markup.match(/class="katex"/g)||[])).toHaveLength(2);
  expect(markup).not.toContain('ai-math-fallback');
  expect(markup).toContain('s_{t+1}');
  expect(markup).toContain('<li>');
});
it("keeps formulas inside named links and emphasis in the same Markdown tree",()=>{
 const markup=renderToStaticMarkup(<AiMarkdownContent entryId="one" text={String.raw`**系数 $x_1$**，见 [策略 $\pi_\theta$](https://example.com/report)。`}/>);
 expect(markup).toMatch(/<strong>系数 <span/);expect(markup).toMatch(/<a [^>]*>策略 <span/);expect((markup.match(/class="katex"/g)||[])).toHaveLength(2);expect(markup).not.toContain('[策略');
});
