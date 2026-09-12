import {expect,it} from "vitest";
import {load} from "cheerio";
import {renderToStaticMarkup} from "react-dom/server";
import {rewriteText} from "../src/main/rewrite-content";
import {rewriteCards} from "../src/main/rewrite-cards";
import {repairRewriteCards,repairRewriteCardSections} from "../src/main/rewrite-card-repair";
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
it("collapses only adjacent legacy fragments belonging to a source-proven card",()=>{
 const cards=rewriteCards(article(card).contentHtml);
 const label=`[报告](<${url}>)`;
 const text=`正文继续引用 ${label}，不能删除。\n\n${label} ${label}[图片说明：Report]\n\n[Report](<${url}>)\n\n${label}[Author](<https://example.com/author>)\n\n·\n\n2025 年 9 月 29 日\n\n阅读全文\n\n${label}\n\n另一段论述 ${label}。`;
 const result=repairRewriteCards(text,cards);
 expect(result.markdown).toBe(`正文继续引用 ${label}，不能删除。\n\n${label}\n\n另一段论述 ${label}。`);
 expect(result.repairs).toHaveLength(1);
 expect(repairRewriteCards(result.markdown,cards).repairs).toHaveLength(0);
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

it("repairs a preview crossing old generation sections without losing neighboring prose",()=>{
 const cards=rewriteCards(article(card).contentHtml);const link=`[报告](<${url}>)`;
 const sections=[`之前正文。\n\n${link} ${link}`,`${link}\n\n阅读全文\n\n${link}\n\n之后正文。`];
 const result=repairRewriteCardSections(sections,cards);
 expect(result.sections).toHaveLength(2);expect(result.markdown).toBe(`之前正文。\n\n${link}\n\n之后正文。`);expect(result.repairs).toHaveLength(1);
});

it("serializes headerless tables, captions, literal pipes and deletion markup without raw HTML",()=>{
 const source=rewriteText(article('<table><caption>Measured results</caption><tr><td>a | b</td><td><del>old</del><br>new</td></tr><tr><td>c</td><td>d</td></tr></table>'));
 const $=load(renderToStaticMarkup(<AiMarkdownContent text={source}/>));
 expect(source).not.toContain('<table');expect($('tbody tr')).toHaveLength(2);expect($('td').first().text()).toBe('a | b');expect($('del').text()).toBe('old');expect($.text()).toContain('Measured results');expect($('td').eq(1).text()).toContain('new');
});

it("does not collapse repeated standalone prose links merely because their destination has a card elsewhere",()=>{
 const cards=rewriteCards(article(card).contentHtml),text=`[One](<${url}>)\n\n[Two](<${url}>)`;
 expect(repairRewriteCards(text,cards).markdown).toBe(text);
});

it("does not absorb unwrapped author prose around a valid preview container",()=>{
 const a=article(`<div>Important unwrapped explanation.${card}An independent conclusion.</div>`);
 const text=rewriteText(a);expect(text).toContain('Important unwrapped explanation.');expect(text).toContain('An independent conclusion.');expect(text.match(/\[Report\]/g)).toHaveLength(1);
});

it.each(["阅读完整文章","阅读完整故事","阅读全文","Read full story"])("removes legacy card action %s while keeping the title, next section and image",action=>{
 const cards=rewriteCards(article(card).contentHtml),title=`[报告](<${url}>)`,after='## GRPO\n\n![图示](<https://example.com/figure.png>)';
 const result=repairRewriteCards(`${title}\n\n阅读完整文章\n\n[${action}](<${url}>)\n\n${after}`,cards);
 expect(result.markdown).toBe(`${title}\n\n${after}`);expect(repairRewriteCards(result.markdown,cards).repairs).toHaveLength(0);
 expect(repairRewriteCards(`${title}\n\n${action}`,cards).markdown).toBe(title);
});
it("never chooses an action as the replacement title or removes the same words from prose/code",()=>{
 const cards=rewriteCards(article(card).contentHtml),text=`[阅读完整故事](<${url}>)\n\n[报告](<${url}>)`;
 expect(repairRewriteCards(text,cards).markdown).toBe(`[报告](<${url}>)`);
 const prose="此处说明如何阅读完整故事。\n\n`阅读完整文章`\n\n[阅读完整故事](<https://example.com/unrelated>)";
 expect(repairRewriteCards(prose,cards).markdown).toBe(prose);
 expect(repairRewriteCards(text,[]).markdown).toBe(text);
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
