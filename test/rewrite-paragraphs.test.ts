import {it,expect,vi} from 'vitest';
import {load} from 'cheerio';
import {normalizePreformattedCode} from '../src/main/reader-code';
import {articleDocumentFromHtml} from '../src/main/article-document';
import {articleDocumentHtml,validArticleDocument} from '../src/shared/article-document';
import {prepareRewriteParagraphs} from '../src/main/rewrite-paragraphs';
import {rewriteArticleDocument} from '../src/main/document-rewrite';
it('normalizes explicitly styled code before losing CSS without guessing JSON prose',()=>{
 const $=load('<div style="white-space:pre; font-family:Menlo, monospace">{\n "deny": ["Read(.env*)"]\n}</div><div>{"ordinary":true}</div><div style="white-space:pre">A poem</div>');normalizePreformattedCode($);
 expect($('pre code').text()).toBe('{\n "deny": ["Read(.env*)"]\n}');expect($('pre').length).toBe(1);expect($('div').length).toBe(2);
});
it('allows Chinese word order while preserving links, code and nested formatting',async()=>{
 const source=articleDocumentFromHtml('<p>Use <a href="https://example.com"><strong>this guide</strong></a> to configure <code>agent</code>.</p>');
 const result=await rewriteArticleDocument(source,'Original title',async(_s,p)=>{
  const input=JSON.parse(p);expect(input.instruction).toContain('通行性优先于中文化');const blocks=input.section.blocks.map((b:any)=>{
   if(b.id==='rewrite-title.text')return {...b,text:'中文标题'};
   const ref=b.text.match(/⟦([^/⟧]+)⟧⟦([^/⟧]+)⟧this guide⟦\/[^⟧]+⟧⟦\/[^⟧]+⟧/)!,code=b.text.match(/⟦[^⟧]+\/⟧/)![0];
   return {...b,text:`配置 ${code} 时，请参阅 ⟦${ref[1]}⟧⟦${ref[2]}⟧本指南⟦/${ref[2]}⟧⟦/${ref[1]}⟧。`};
  });return JSON.stringify({blocks});
 },new AbortController().signal,undefined,undefined,undefined,true);
 expect(result.rewrittenTitle).toBe('中文标题');expect(validArticleDocument(result.content)).toBe(true);
 expect(articleDocumentHtml(result.content)).toContain('配置 <code>agent</code> 时，请参阅 <a href="https://example.com"><strong>本指南</strong></a>。');
});
it('removes only a model-echoed adjacent link label, keeping its link and authored repetition',()=>{
 const rewrite=(html:string,change:(text:string,link:string)=>string)=>{
  const prepared=prepareRewriteParagraphs(articleDocumentFromHtml(html));
  const paragraph=(prepared.document.children[0] as any).children[0];
  const link=paragraph.text.match(/⟦[^/⟧]+⟧本指南⟦\/[^⟧]+⟧/)?.[0];
  expect(link).toBeDefined();
  paragraph.text=change(paragraph.text,link!);
  return articleDocumentHtml(prepared.restore(prepared.document));
 };
 const source='<p>请阅读<a href="https://example.com/guide">本指南</a>。</p>';
 expect(rewrite(source,(text,link)=>text.replace(link,`本指南${link}`))).toBe('<p>请阅读<a href="https://example.com/guide">本指南</a>。</p>');
 expect(rewrite(source,(text,link)=>text.replace(link,`${link}本指南`))).toBe('<p>请阅读<a href="https://example.com/guide">本指南</a>。</p>');
 expect(rewrite('<p>本指南<a href="https://example.com/guide">本指南</a>。</p>',text=>text)).toBe('<p>本指南<a href="https://example.com/guide">本指南</a>。</p>');
 expect(rewrite(source,(text,link)=>text.replace(link,`本指南；${link}`))).toContain('本指南；<a href="https://example.com/guide">本指南</a>');
 const nested=prepareRewriteParagraphs(articleDocumentFromHtml('<p>See <a href="https://example.com/kv"><strong>KV cache</strong></a>.</p>'));
 const paragraph=(nested.document.children[0] as any).children[0];
 paragraph.text=paragraph.text.replace('See ', 'See KV cache ');
 expect(articleDocumentHtml(nested.restore(nested.document))).toBe('<p>See <a href="https://example.com/kv"><strong>KV cache</strong></a>.</p>');
 const footnote=prepareRewriteParagraphs(articleDocumentFromHtml('<p>Equation <a href="https://example.com/note">1</a>.</p>'));
 const note=(footnote.document.children[0] as any).children[0];
 note.text=note.text.replace('Equation ', 'Equation 1 ');
 expect(articleDocumentHtml(footnote.restore(footnote.document))).toBe('<p>Equation 1 <a href="https://example.com/note">1</a>.</p>');
 const compound=prepareRewriteParagraphs(articleDocumentFromHtml('<p>Open<a href="https://example.com/ai">AI</a></p>'));
 const compoundText=(compound.document.children[0] as any).children[0];
 compoundText.text=compoundText.text.replace('Open', 'OpenAI');
 expect(articleDocumentHtml(compound.restore(compound.document))).toBe('<p>OpenAI<a href="https://example.com/ai">AI</a></p>');
});
it('keeps technical terms in English when they are clearer and isolates the new prompt from version 12',async()=>{
 const source=articleDocumentFromHtml('<p>KV cache uses <a href="https://example.com/guide">the guide</a>.</p>');
 const instructions:string[]=[];
 const run=async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);instructions.push(input.instruction);
  return JSON.stringify({blocks:input.section.blocks.map((block:any)=>({...block,text:block.id==='rewrite-title.text'?'技术文章':block.text.replace('the guide','指南')}))});
 };
 await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined,true,13);
 expect(instructions[0]).toContain('直接保留英文');
 expect(instructions[0]).not.toContain('选择准确、通行且前后一致的中文表达');
 instructions.length=0;
 await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined,true,12);
 expect(instructions[0]).not.toContain('不以翻成中文为目标');
});
it('rejects missing references, foreign references and nesting changes',()=>{
 const doc=articleDocumentFromHtml('<p>See <a href="https://example.com"><strong>guide</strong></a> <code>x</code></p>');
 for(const change of [(t:string)=>t.replace(/⟦[^⟧]+\/⟧/,''),(t:string)=>t+'⟦foreign/⟧',(t:string)=>t.replace('guide','')]){
  const p=prepareRewriteParagraphs(doc),node=(p.document.children[0] as any).children[0];node.text=change(node.text);expect(()=>p.restore(p.document)).toThrow();
 }
});
it('does not call models for asset-only documents',async()=>{
 const run=vi.fn();const doc=articleDocumentFromHtml('<pre><code>x</code></pre>');
 await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);expect(run).not.toHaveBeenCalled();
});
it('resumes paragraph checkpoints including the title without new requests',async()=>{
 const doc=articleDocumentFromHtml('<p>Agent <em>workflow</em>.</p>');let checkpoint:any;
 const result=await rewriteArticleDocument(doc,'Title',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks}),new AbortController().signal,undefined,undefined,c=>checkpoint=c,true);
 const run=vi.fn();const resumed=await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,checkpoint,undefined,true);expect(resumed.content).toEqual(result.content);expect(resumed.rewrittenTitle).toBe('Title');expect(run).not.toHaveBeenCalled();
});
it('repairs only one failed paragraph reference and never loops',async()=>{
 const source=articleDocumentFromHtml('<p>Use <code>x</code>.</p><p>Second paragraph.</p>');
 const run=vi.fn(async(_s:string,p:string)=>{const input=JSON.parse(p);const blocks=input.section.blocks.map((b:any)=>({...b,text:run.mock.calls.length===1?b.text.replace(/⟦[^⟧]+\/⟧/g,''):b.text}));return JSON.stringify({blocks});});
 const result=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);
 expect(run).toHaveBeenCalledTimes(2);expect(JSON.parse(run.mock.calls[1][1]).section.blocks).toHaveLength(1);expect(result.quality.repairedSections).toBe(1);
 const bad=vi.fn(async(_s:string,p:string)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({...b,text:b.text.replace(/⟦[^⟧]+\/⟧/g,'')}))}));
 await expect(rewriteArticleDocument(source,'Title',bad,new AbortController().signal,undefined,undefined,undefined,true)).rejects.toThrow();expect(bad).toHaveBeenCalledTimes(2);
});
it('round-trips mixed scientific, list, table and media structures through paragraph protocol',async()=>{
 const source=articleDocumentFromHtml('<h2>Heading</h2><ul><li>Outer <em>item</em><ul><li>Inner</li></ul></li></ul><table><tr><td>Cell <a href="https://example.com/a">link</a></td></tr></table><p>Equation <span data-reader-tex="x_1">x_1</span> (1).</p><figure><img src="https://example.com/a.png"><figcaption>Caption</figcaption></figure><pre><code>  x = 1\n</code></pre>');
 const output=await rewriteArticleDocument(source,'Title',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks}),new AbortController().signal,undefined,undefined,undefined,true);
 expect(articleDocumentHtml(output.content)).toBe(articleDocumentHtml(source));
});
it('describes numbered references and sends exact failure feedback on local repair',async()=>{
 const doc=articleDocumentFromHtml('<ol><li><span>04</span><a href="https://example.com/paper">Authors. Paper.</a></li></ol>');
 let missing='';const run=vi.fn(async(_s:string,p:string)=>{
  const v=JSON.parse(p);const span=v.references.find((r:any)=>r.kind==='span');expect(span.parent).toBeNull();expect(span.open).toBe(`⟦${span.id}⟧`);expect(span.close).toBe(`⟦/${span.id}⟧`);
  if(run.mock.calls.length===1){missing=span.id;return JSON.stringify({blocks:v.section.blocks.map((b:any)=>({...b,text:b.text.replace(span.open,'').replace(span.close,'')}))});}
  expect(v.repair).toEqual({paragraph:span.paragraph,reference:missing,reason:'missing'});expect(v.section.blocks).toHaveLength(1);return JSON.stringify({blocks:v.section.blocks});
 });
 const r=await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);
 expect(articleDocumentHtml(r.content)).toContain('<span>04</span><a href="https://example.com/paper">Authors. Paper.</a>');expect(run).toHaveBeenCalledTimes(2);
});
it('never leaks model-supplied unknown identifiers in reference diagnostics',()=>{
 const p=prepareRewriteParagraphs(articleDocumentFromHtml('<p>A <em>word</em></p>'));
 (p.document.children[0] as any).children[0].text='⟦private-message/⟧';
 expect(()=>p.restore(p.document)).toThrow('unknown/syntax');try{p.restore(p.document)}catch(e){expect(String(e)).not.toContain('private-message');}
});
