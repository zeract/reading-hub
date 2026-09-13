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
  const input=JSON.parse(p);expect(input.instruction).toContain('不预设');const blocks=input.section.blocks.map((b:any)=>{
   if(b.id==='rewrite-title.text')return {...b,text:'中文标题'};
   const ref=b.text.match(/⟦([^/⟧]+)⟧⟦([^/⟧]+)⟧this guide⟦\/[^⟧]+⟧⟦\/[^⟧]+⟧/)!,code=b.text.match(/⟦[^⟧]+\/⟧/)![0];
   return {...b,text:`配置 ${code} 时，请参阅 ⟦${ref[1]}⟧⟦${ref[2]}⟧本指南⟦/${ref[2]}⟧⟦/${ref[1]}⟧。`};
  });return JSON.stringify({blocks});
 },new AbortController().signal,undefined,undefined,undefined,true);
 expect(result.rewrittenTitle).toBe('中文标题');expect(validArticleDocument(result.content)).toBe(true);
 expect(articleDocumentHtml(result.content)).toContain('配置 <code>agent</code> 时，请参阅 <a href="https://example.com"><strong>本指南</strong></a>。');
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
