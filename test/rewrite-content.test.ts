import { expect,it } from "vitest";
import { rewriteText,splitRewriteText } from "../src/main/rewrite-content";
import { extractReaderArticle } from "../src/main/article-reader";
import type { Entry } from "../src/shared/types";
const prose="The conclusion follows from the evidence; preserve its scope and limitations. ".repeat(10);
const article=(body:string)=>extractReaderArticle(`<article><p>${prose}</p>${body}</article>`,"https://example.com/post",{id:"fixture",url:"https://example.com/post",title:"Fixture"} as Entry)!.article;
it("retains one source TeX expression, code and links without rendered duplicates or source HTML",()=>{
 const text=rewriteText(article('<p>Inline $x_1^2$.</p><pre><code>a &lt; b</code></pre><a href="/ref">Reference</a>'));
 expect(text.match(/x_1\^2/g)).toHaveLength(1);expect(text).toContain('a < b');expect(text).toContain('https://example.com/ref');expect(text).not.toContain('<span');
});
it("does not rewrite a feed summary as if it were the full article",()=>{expect(()=>rewriteText({...article(""),contentMode:"feed_summary"})).toThrow("摘要");});
it("preserves code and display-math blocks while splitting long text without dropping content",()=>{
 const blocks=["a".repeat(60),"```\ncode\n\nsecond line\n```","$$\nx+y\n\n=z\n$$","b".repeat(60)];
 const chunks=splitRewriteText(blocks.join("\n\n"),100);expect(chunks.length).toBeGreaterThan(1);expect(chunks.join("\n\n")).toBe(blocks.join("\n\n"));
 expect(chunks.some(c=>c.includes(blocks[1]))).toBe(true);expect(chunks.some(c=>c.includes(blocks[2]))).toBe(true);
});
it("fails explicitly on an overlong block instead of rewriting only an excerpt",()=>{expect(()=>splitRewriteText("x".repeat(101),100)).toThrow("过长");});
it("keeps locally preserved MathJax SVG source and explicit fallback formulas as TeX",()=>{
 const value=article("");value.contentHtml+=`<mjx-container data-reader-tex="x+y=z" data-reader-math-display="true"><svg><path d="M0 0"/></svg></mjx-container><code class="reader-math-source">\\unknown{x}</code>`;
 const text=rewriteText(value);expect(text).toContain("$$\nx+y=z\n$$");expect(text).toContain("$\\unknown{x}$");
});

it("preserves image URLs and produces explicit Markdown links with safe delimiters",()=>{
 const value=article('<p><a href="https://example.com/a_(b)?q=1&amp;x=2">链接 [一]</a></p><figure><a href="https://example.com/full"><img src="https://example.com/img_(1).png" alt="图 [一]"></a><figcaption>图注</figcaption></figure>');
 const text=rewriteText(value);
 expect(text).toContain('[链接 \\[一\\]](<https://example.com/a_(b)?q=1&x=2>)');
 expect(text).toContain('![图 \\[一\\]](<https://example.com/img_(1).png>)');
 expect(text).toContain('图注');expect(text).not.toContain('https://example.com/full');
});
