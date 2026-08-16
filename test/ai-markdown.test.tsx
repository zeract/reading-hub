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
    const markup = renderToStaticMarkup(<AiMarkdownContent text={"```tex\n$t$\n```"} />);
    expect(markup).toContain("$t$");
    expect(markup).not.toContain("class=\"katex");
  });
});
