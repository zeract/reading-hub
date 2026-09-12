import {expect,it} from "vitest";
import {load} from "cheerio";
import {renderToStaticMarkup} from "react-dom/server";
import {rewriteText} from "../src/main/rewrite-content";
import {rewriteCards} from "../src/main/rewrite-cards";
import {runRewritePipeline,makeRewriteSections} from "../src/main/rewrite-pipeline";
import {AiMarkdownContent} from "../src/renderer/ai-markdown";
import {extractReaderArticle} from "../src/main/article-reader";
import type {Entry} from "../src/shared/types";
const url="https://example.com/report";
const card=`<div><a href="${url}">${url}</a><div><a href="${url}"><img src="https://example.com/cover.png" alt="Report"></a><div><a href="${url}"><h4>Report</h4></a><a href="https://example.com/author">Author</a><div>September 29, 2025</div><a href="${url}">Read full story</a></div></div></div>`;
const prose="This argument applies only under the stated assumptions; it is not a universal conclusion. ".repeat(4);
const article=(body:string)=>extractReaderArticle(`<article><p>${prose}</p>${body}</article>`,"https://example.com/post",{id:"fixture",url:"https://example.com/post",title:"Fixture"} as Entry)!.article;

it("preserves the complete article structure from safe HTML through generation into real DOM",async()=>{
 const input=article(`<h2>Methods</h2><p><strong>Important</strong>: see <a href="${url}">the evidence</a> and <code>value_name</code>.</p><ol start="3"><li>Outer<ul><li>Inner</li></ul></li><li>Second</li></ol><blockquote><p>First quote</p><p>Second quote</p></blockquote><table><thead><tr><th>Method</th><th>Cost</th></tr></thead><tbody><tr><td>Linear</td><td>$O(n)$</td></tr></tbody></table><figure><img src="https://example.com/plot.png" alt="Result"><figcaption>Observed result, with limitations.</figcaption></figure><pre><code>if ready:\n    value = 1\n\n    print(value)</code></pre>${card}<p>Independently consult <a href="${url}">this report</a> for another claim.</p>`);
 const source=rewriteText(input);let calls=0;
 const result=await runRewritePipeline(source,"Fixture",async(_stage,prompt)=>{
  calls++;return JSON.stringify({blocks:JSON.parse(prompt).section.blocks}).replace('the evidence','对应证据').replace('Methods','方法');
 },new AbortController().signal);
 const $=load(renderToStaticMarkup(<AiMarkdownContent text={result.markdown} entryId="fixture"/>));
 expect(calls).toBe(1);expect($('h2').text()).toBe('方法');expect($('strong').text()).toBe('Important');expect($('ol').attr('start')).toBe('3');expect($('ol > li > ul > li').text()).toBe('Inner');expect($('blockquote p')).toHaveLength(2);expect($('tbody tr td')).toHaveLength(2);expect($('.katex')).toHaveLength(1);expect($('img')).toHaveLength(1);expect($('img').attr('src')).toBeUndefined();expect($('img').parent().text()).toContain('Observed result');expect($('pre code').text()).toContain('    value = 1\n\n    print(value)');expect($(`a[href="${url}"]`)).toHaveLength(3);expect($.text()).not.toContain('Read full story');expect($.text()).not.toContain('September 29');
 expect(makeRewriteSections(source).flatMap(s=>s.blocks).some(b=>b.text.includes('![Result]') && b.text.includes('Observed result'))).toBe(true);
});
it("does not classify normal linked headings, repeated prose or a gallery as a preview",()=>{
 const a=article(`<h2><a href="${url}">An authored section</a></h2><p>${prose}<a href="${url}">Read full story</a></p><figure><a href="${url}"><img src="https://example.com/plot.png"></a></figure>`);
 expect(rewriteCards(a.contentHtml)).toHaveLength(0);expect(rewriteText(a)).toContain('An authored section');expect(rewriteText(a)).toContain('![图片]');
});
it("keeps raw HTML inert and correctly nests block quotes, lists, escaped table pipes and long fences",()=>{
 const text='> 1. Outer\n>    - Inner\n\n| A | B |\n| --- | --- |\n| a \\| b | `value` |\n\n````python\n```\n$x$\n````\n\n<script>alert(1)</script>';
 const $=load(renderToStaticMarkup(<AiMarkdownContent text={text}/>));expect($('blockquote ol ul li').text()).toBe('Inner');expect($('td').first().text()).toBe('a | b');expect($('pre').text()).toBe('```\n$x$');expect($('script')).toHaveLength(0);expect($('.katex')).toHaveLength(0);
});
it("rejects asset movement across blocks and missing list structure without checkpointing",async()=>{
 const source='Paragraph one ![figure](<https://example.com/plot.png>).\n\n- First\n- Second';let saved=false;
 await expect(runRewritePipeline(source,'Fixture',async(_s,p)=>{
  const blocks=JSON.parse(p).section.blocks;const marker=blocks[0].text.match(/⟦B\d+_A1⟧/)[0];
  blocks[0].text=blocks[0].text.replace(marker,'');blocks[1].text=blocks[1].text.replace('- First',`- First ${marker}`);
  return JSON.stringify({blocks});
 },new AbortController().signal,undefined,{save:()=>{saved=true;}})).rejects.toThrow('asset-marker');expect(saved).toBe(false);
 await expect(runRewritePipeline(source,'Fixture',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({...b,text:b.text.replace('- First\n- Second','First and Second')}))}),new AbortController().signal)).rejects.toThrow('列表');
});

it("keeps conditional-probability pipes inside table cells and fenced code literal",()=>{
 const $=load(renderToStaticMarkup(<AiMarkdownContent text={'| Distribution $P(a | s)$ | Cost |\n| --- | --- |\n| $P(b | s)$ | $O(n)$ |\n\n```\n| $literal | text$ |\n```'}/>));
 expect($('th')).toHaveLength(2);expect($('td')).toHaveLength(2);expect($('.katex')).toHaveLength(3);expect($('pre').text()).toBe('| $literal | text$ |');expect($.html()).not.toMatch(/[\uE000-\uF8FF]/);
});

it("serializes headerless tables, captions, literal pipes and deletion markup without raw HTML",()=>{
 const source=rewriteText(article('<table><caption>Measured results</caption><tr><td>a | b</td><td><del>old</del><br>new</td></tr><tr><td>c</td><td>d</td></tr></table>'));
 const $=load(renderToStaticMarkup(<AiMarkdownContent text={source}/>));
 expect(source).not.toContain('<table');expect($('tbody tr')).toHaveLength(2);expect($('td').first().text()).toBe('a | b');expect($('del').text()).toBe('old');expect($.text()).toContain('Measured results');expect($('td').eq(1).text()).toContain('new');
});

it("does not absorb unwrapped author prose around a valid preview container",()=>{
 const a=article(`<div>Important unwrapped explanation.${card}An independent conclusion.</div>`);
 const text=rewriteText(a);expect(text).toContain('Important unwrapped explanation.');expect(text).toContain('An independent conclusion.');expect(text.match(/\[Report\]/g)).toHaveLength(1);
});

it.each([
 ['科学空间',String.raw`## 条件概率

参见 [推导 $P(a|s)$](https://spaces.ac.cn/example)，有 $\pi_\theta(a_t|s_t)$。

$$
x_{t+1}=f(x_t)\tag{7}
$$`],
 ['普通 RSS','## Example\n\nRead [the report](https://example.com/report) and `x[y]`.\n\n![chart](https://example.com/chart.png)'],
 ['知乎','## 回答\n\n具体限定见 [回答原文](https://www.zhihu.com/question/123/answer/456)。\n\n> 仅在满足假设时成立。'],
 ['AI 学习',String.raw`## 推导

参考 [算法说明](https://example.com/algorithm)，时间复杂度 $O(n)$。

| 项目 | 表达式 |
| --- | --- |
| 概率 | $P(a | s)$ |`]
])("preserves %s fixture assets through structured rewriting and the shared renderer",async(title,text)=>{
 const result=await runRewritePipeline(text,title,async(_stage,prompt)=>JSON.stringify({blocks:JSON.parse(prompt).section.blocks}),new AbortController().signal);
 const $=load(renderToStaticMarkup(<AiMarkdownContent text={result.markdown} entryId="fixture"/>));
 expect($('h2')).toHaveLength(1);expect($('a[href^="https:"]')).toHaveLength(1);
 expect($.text()).not.toMatch(/⟦B\d+_|\(B\d+_L\d+\)/);
 if(title==='科学空间'){expect($('.katex')).toHaveLength(3);expect($.text()).toContain('(7)');}
 if(title==='普通 RSS'){expect($('img')).toHaveLength(1);expect($('code').text()).toBe('x[y]');}
 if(title==='知乎')expect($('blockquote')).toHaveLength(1);
 if(title==='AI 学习'){expect($('td')).toHaveLength(2);expect($('.katex')).toHaveLength(2);}
});
