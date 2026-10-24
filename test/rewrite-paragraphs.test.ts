import {it,expect,vi} from 'vitest';
import {load} from 'cheerio';
import {normalizePreformattedCode} from '../src/main/reader-code';
import {articleDocumentFromHtml} from '../src/main/article-document';
import {articleDocumentHtml,validArticleDocument} from '../src/shared/article-document';
import {prepareRewriteParagraphs,ParagraphReferenceValidationError} from '../src/main/rewrite-paragraphs';
import {rewriteArticleDocument,type DocumentCheckpoint} from '../src/main/document-rewrite';
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
 },new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
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
 await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
 expect(instructions[0]).toContain('直接保留英文');
 expect(instructions[0]).not.toContain('选择准确、通行且前后一致的中文表达');
 instructions.length=0;
 await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:12});
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
 await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});expect(run).not.toHaveBeenCalled();
});
it('resumes paragraph checkpoints including the title without new requests',async()=>{
 const doc=articleDocumentFromHtml('<p>Agent <em>workflow</em>.</p>');let checkpoint:any;
 const result=await rewriteArticleDocument(doc,'Title',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks}),new AbortController().signal,undefined,undefined,c=>checkpoint=c, {kind:"paragraphs",version:13});
 const run=vi.fn();const resumed=await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,checkpoint,undefined, {kind:"paragraphs",version:13});expect(resumed.content).toEqual(result.content);expect(resumed.rewrittenTitle).toBe('Title');expect(run).not.toHaveBeenCalled();
});
it('repairs only one failed paragraph reference and never loops',async()=>{
 const source=articleDocumentFromHtml('<p>Use <code>x</code>.</p><p>Second paragraph.</p>');
 const run=vi.fn(async(_s:string,p:string)=>{const input=JSON.parse(p);const blocks=input.section.blocks.map((b:any)=>({...b,text:run.mock.calls.length===1?b.text.replace(/⟦[^⟧]+\/⟧/g,''):b.text}));return JSON.stringify({blocks});});
 const result=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
 expect(run).toHaveBeenCalledTimes(2);expect(JSON.parse(run.mock.calls[1][1]).section.blocks).toHaveLength(1);expect(result.quality.repairedSections).toBe(1);
 const bad=vi.fn(async(_s:string,p:string)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({...b,text:b.text.replace(/⟦[^⟧]+\/⟧/g,'')}))}));
 await expect(rewriteArticleDocument(source,'Title',bad,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13})).rejects.toThrow();expect(bad).toHaveBeenCalledTimes(2);
});
it('round-trips mixed scientific, list, table and media structures through paragraph protocol',async()=>{
 const source=articleDocumentFromHtml('<h2>Heading</h2><ul><li>Outer <em>item</em><ul><li>Inner</li></ul></li></ul><table><tr><td>Cell <a href="https://example.com/a">link</a></td></tr></table><p>Equation <span data-reader-tex="x_1">x_1</span> (1).</p><figure><img src="https://example.com/a.png"><figcaption>Caption</figcaption></figure><pre><code>  x = 1\n</code></pre>');
 const output=await rewriteArticleDocument(source,'Title',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks}),new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
 expect(articleDocumentHtml(output.content)).toBe(articleDocumentHtml(source));
});
it('describes numbered references and sends exact failure feedback on local repair',async()=>{
 const doc=articleDocumentFromHtml('<ol><li><span>04</span><a href="https://example.com/paper">Authors. Paper.</a></li></ol>');
 let missing='';const run=vi.fn(async(_s:string,p:string)=>{
  const v=JSON.parse(p);const span=v.references.find((r:any)=>r.kind==='span');expect(span.parent).toBeNull();expect(span.open).toBe(`⟦${span.id}⟧`);expect(span.close).toBe(`⟦/${span.id}⟧`);
  if(run.mock.calls.length===1){missing=span.id;return JSON.stringify({blocks:v.section.blocks.map((b:any)=>({...b,text:b.text.replace(span.open,'').replace(span.close,'')}))});}
  expect(v.repair).toEqual({issues:[{paragraph:span.paragraph,reference:missing,reason:'missing'}]});expect(v.section.blocks).toHaveLength(1);return JSON.stringify({blocks:v.section.blocks});
 });
 const r=await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
 expect(articleDocumentHtml(r.content)).toContain('<span>04</span><a href="https://example.com/paper">Authors. Paper.</a>');expect(run).toHaveBeenCalledTimes(2);
});
it('never leaks model-supplied unknown identifiers in reference diagnostics',()=>{
 const p=prepareRewriteParagraphs(articleDocumentFromHtml('<p>A <em>word</em></p>'));
 (p.document.children[0] as any).children[0].text='⟦private-message/⟧';
 expect(()=>p.restore(p.document)).toThrow('unknown/syntax');try{p.restore(p.document)}catch(e){expect(String(e)).not.toContain('private-message');}
});
it('repairs every invalid paragraph in the section together, retaining valid translations',async()=>{
 const source=articleDocumentFromHtml('<p>Use <code>x</code>.</p><p>The datasets combine <a href="https://example.com/a">comparisons</a>, <a href="https://example.com/b">summaries</a> and <a href="https://example.com/c">preferences</a>.</p><p>A valid paragraph.</p>');
 let affected:string[]=[];
 const run=vi.fn(async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length===1){
   const blocks=input.section.blocks.map((b:any)=>{
    if(b.text.includes('Use ')){affected.push(b.id);return {...b,text:b.text.replace(/⟦[^⟧]+\/⟧/,'')};}
    if(b.text.includes('The datasets')){affected.push(b.id);const first=input.references.find((r:any)=>r.paragraph===b.id);return {...b,text:b.text.replace(first.close,'')};}
    return {...b,text:b.text==='A valid paragraph.'?'已成功的段落。':b.text};
   });return JSON.stringify({blocks});
  }
  expect(input.section.blocks.map((b:any)=>b.id)).toEqual(affected);
  expect(input.repair.issues.map((issue:any)=>issue.reason)).toEqual(['missing','nesting']);
  return JSON.stringify({blocks:input.section.blocks});
 });
 const result=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
 expect(run).toHaveBeenCalledTimes(2);expect(result.quality.repairedSections).toBe(1);
 const html=articleDocumentHtml(result.content);expect(html).toContain('已成功的段落。');expect(load(html)('a')).toHaveLength(3);
});
it('repairs missing blocks and malformed received references in the same bounded request',async()=>{
 const source=articleDocumentFromHtml('<p>A missing paragraph.</p><p>Use <code>agent</code>.</p><p>A valid paragraph.</p>');
 const run=vi.fn(async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length===1)return JSON.stringify({blocks:input.section.blocks.filter((b:any)=>b.text!=='A missing paragraph.').map((b:any)=>({...b,text:b.text.replace(/⟦[^⟧]+\/⟧/,'')}))});
  expect(input.section.blocks).toHaveLength(2);expect(input.repair.issues.map((issue:any)=>issue.reason)).toEqual(['missing','missing']);
  return JSON.stringify({blocks:input.section.blocks});
 });
 const result=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined, {kind:"paragraphs",version:13});
 expect(articleDocumentHtml(result.content)).toBe(articleDocumentHtml(source));expect(run).toHaveBeenCalledTimes(2);
});
it('collects safe diagnostics without returning a partially restored document or changing source nesting',()=>{
 const prepared=prepareRewriteParagraphs(articleDocumentFromHtml('<p><a href="https://example.com"><em>First</em></a> and <strong>second</strong>.</p><p><span>Another</span></p>'));
 const blocks=(prepared.document.children as any[]).map(p=>p.children[0]);
 const refs=prepared.references(new Set(blocks.map(p=>p.id)));
 const child=refs.find(r=>r.kind==='em')!,outer=refs.find(r=>r.kind==='a')!;
 blocks[0].text=blocks[0].text.replace(child.open,'').replace(child.close!,'')+`${child.open}moved${child.close}`;
 blocks[1].text='⟦not-a-source-private-identifier/⟧';
 const before=structuredClone(prepared.document);
 try{prepared.restore(prepared.document);throw new Error('Expected validation failure');}catch(error){
  expect(error).toBeInstanceOf(ParagraphReferenceValidationError);
  expect((error as ParagraphReferenceValidationError).issues).toEqual([
   {paragraph:blocks[0].id,reference:child.id,reason:'nesting'},
   {paragraph:blocks[1].id,reference:'unknown',reason:'syntax'}
  ]);
  expect(JSON.stringify(error)).not.toContain('private-identifier');
 }
 expect(prepared.document).toEqual(before);expect(child.parent).toBe(outer.id);
});
it('resumes the second of six sections with one batched repair and preserves the first checkpoint',async()=>{
 const source=articleDocumentFromHtml(`<p>${'First section. '.repeat(350)}</p><p>${'Some context. '.repeat(100)}<code>agent</code></p><p>${'Other context. '.repeat(100)}<a href="https://example.com/a">first</a>, <a href="https://example.com/b">second</a>.</p>${Array.from({length:4},()=>`<p>${'Later section. '.repeat(350)}</p>`).join('')}`);
 const corrupt=(input:any)=>({blocks:input.section.blocks.map((b:any)=>{
  if(b.text.includes('Some context.'))return {...b,text:b.text.replace(/⟦[^⟧]+\/⟧/,'')};
  if(b.text.includes('Other context.')){const link=input.references.find((r:any)=>r.paragraph===b.id);return {...b,text:b.text.replace(link.close,'')};}
  return b;
 })});
 let checkpoint:DocumentCheckpoint|undefined;
 const failed=async(_s:string,p:string)=>{const input=JSON.parse(p);return JSON.stringify(input.repair?{blocks:input.section.blocks.map((b:any)=>({id:b.id,parts:[]}))}:input.section.id==='S2'?corrupt(input):{blocks:input.section.blocks});};
 await expect(rewriteArticleDocument(source,'Title',failed,new AbortController().signal,undefined,undefined,c=>checkpoint=c, {kind:"paragraphs",version:13})).rejects.toThrow('第 2/6 节');
 expect(checkpoint?.patches).toHaveLength(1);const saved=structuredClone(checkpoint!);
 const resumed=vi.fn(async(_s:string,p:string)=>{
  const input=JSON.parse(p);expect(input.section.id).not.toBe('S1');
  return JSON.stringify(input.section.id==='S2'&&!input.repair?corrupt(input):{blocks:input.section.blocks});
 });
 const result=await rewriteArticleDocument(source,'Title',resumed,new AbortController().signal,undefined,checkpoint,c=>checkpoint=c, {kind:"paragraphs",version:13});
 expect(resumed).toHaveBeenCalledTimes(6);expect(checkpoint?.patches).toHaveLength(6);
 expect(checkpoint?.patches[0]).toEqual(saved.patches[0]);expect(result.quality.repairedSections).toBe(1);
 expect(articleDocumentHtml(result.content)).toBe(articleDocumentHtml(source));
});

it('uses structured inline subtrees for the one repair after a missing closing marker',async()=>{
 const source=articleDocumentFromHtml('<p><strong>Generative systems</strong> (<a href="https://example.com/paper">Authors, 2023</a>) preserve context.</p>');
 let outer='',link='';
 const run=vi.fn(async(_s:string,p:string)=>{
  const v=JSON.parse(p),refs=v.references;outer=refs.find((r:any)=>r.kind==='strong').id;link=refs.find((r:any)=>r.kind==='a').id;
  if(!v.repair)return JSON.stringify({blocks:v.section.blocks.map((b:any)=>({...b,text:b.text.replace(`⟦/${link}⟧`,'')}))});
  expect(v.instruction).toContain('parts');expect(v.repair.issues[0].reason).toBe('unclosed');
  expect(v.section.blocks[0].parts).toEqual([{ref:outer,parts:['Generative systems']},' (',{ref:link,parts:['Authors, 2023']},') preserve context.']);
  expect(v.section.blocks[0]).not.toHaveProperty('text');
  return JSON.stringify({blocks:v.section.blocks.map((b:any)=>({id:b.id,parts:[{ref:outer,parts:['生成系统']},'（',{ref:link,parts:['作者，2023']},'）保留上下文。']}))});
 });
 const r=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined,{kind:'paragraphs',version:13});
 expect(run).toHaveBeenCalledTimes(2);expect(r.quality.requests).toBe(2);
 expect(articleDocumentHtml(r.content)).toBe('<p><strong>生成系统</strong>（<a href="https://example.com/paper">作者，2023</a>）保留上下文。</p>');
});

it('restores only source-owned typed subtrees and rejects foreign, duplicated, reparented or renamed references',()=>{
 const source=articleDocumentFromHtml('<p><a href="https://example.com/paper"><em>Paper</em></a> uses <code>x</code>.<br></p>');
 const p=prepareRewriteParagraphs(source),block=(p.document.children[0] as any).children[0],refs=p.references(new Set([block.id]));
 const link=refs.find(r=>r.kind==='a')!,em=refs.find(r=>r.kind==='em')!,code=refs.find(r=>r.kind==='code')!,br=refs.find(r=>r.kind==='br')!;
 const valid=[{ref:link.id,parts:[{ref:em.id,parts:['论文']}]},' 使用 ',{ref:code.id},'。',{ref:br.id}];
 expect(p.fromParts(block.id,p.toParts(block))).toBe(block.text);
 const restore=(parts:unknown)=>{const draft=structuredClone(p.document);(draft.children[0] as any).children[0].text=p.fromParts(block.id,parts);return articleDocumentHtml(p.restore(draft));};
 expect(restore(valid)).toBe('<p><a href="https://example.com/paper"><em>论文</em></a> 使用 <code>x</code>。<br></p>');
 for(const invalid of [[...valid,{ref:code.id}], [{ref:em.id,parts:['论文']},...valid], [{ref:'private-model-identifier',parts:['x']},...valid], [{ref:link.id,parts:[]},...valid.slice(1)], [{ref:code.id,parts:['changed']},...valid]]){
  expect(()=>restore(invalid)).toThrow();
 }
 try{restore([{ref:'private-model-identifier'}])}catch(e){expect(String(e)).not.toContain('private-model-identifier')}
});

it('keeps all four checkpoints when resuming six sections and repairs typed references only in section five',async()=>{
 const source=articleDocumentFromHtml(`${Array.from({length:4},()=>`<p>${'Earlier section. '.repeat(350)}</p>`).join('')}<p>${'Current context. '.repeat(200)}<a href="https://example.com/one">Paper</a> closes here.</p><p>${'Final section. '.repeat(350)}</p>`);
 let checkpoint:DocumentCheckpoint|undefined;
 const failed=async(_s:string,p:string)=>{const v=JSON.parse(p);const close=v.references?.find((r:any)=>r.kind==='a')?.close;return JSON.stringify({blocks:v.section.blocks.map((b:any)=>v.repair?{id:b.id,parts:[]}:{...b,text:close?b.text.replace(close,''):b.text})});};
 await expect(rewriteArticleDocument(source,'Title',failed,new AbortController().signal,undefined,undefined,c=>checkpoint=c,{kind:'paragraphs',version:13})).rejects.toThrow('第 5/6 节');
 expect(checkpoint!.patches).toHaveLength(4);const firstFour=structuredClone(checkpoint!.patches);
 const resumed=vi.fn(async(_s:string,p:string)=>{
  const v=JSON.parse(p);expect(['S5','S6']).toContain(v.section.id);
  if(!v.repair)return failed(_s,p);
  const ref=v.references.find((r:any)=>r.kind==='a');expect(v.section.id).toBe('S5');
  return JSON.stringify({blocks:v.section.blocks.map((b:any)=>({id:b.id,parts:['当前上下文。',{ref:ref.id,parts:['论文']},' 在此结束。']}))});
 });
 await rewriteArticleDocument(source,'Title',resumed,new AbortController().signal,undefined,checkpoint,c=>checkpoint=c,{kind:'paragraphs',version:13});
 expect(resumed).toHaveBeenCalledTimes(3);expect(checkpoint!.patches).toHaveLength(6);expect(checkpoint!.patches.slice(0,4)).toEqual(firstFour);
});

it('keeps literal delimiters and readonly assets distinct, and rejects malformed parts',()=>{
 const p=prepareRewriteParagraphs(articleDocumentFromHtml('<p>A literal ⟦ value with <code>x</code>.</p>'));
 const block=(p.document.children[0] as any).children[0],code=p.references(new Set([block.id])).find(r=>r.kind==='code')!;
 const draft=structuredClone(p.document);(draft.children[0] as any).children[0].text=p.fromParts(block.id,['字面字符 ⟦ 和 ',{ref:code.id},'。']);
 expect(articleDocumentHtml(p.restore(draft))).toBe('<p>字面字符 ⟦ 和 <code>x</code>。</p>');
 for(const bad of [null,[12],[{ref:code.id,extra:'x'}],[{parts:['x']}],[['nested strings']]])expect(()=>p.fromParts(block.id,bad)).toThrow();
 const nested=prepareRewriteParagraphs(articleDocumentFromHtml('<p><strong>Nested</strong></p>')),target=(nested.document.children[0] as any).children[0],strong=nested.references(new Set([target.id]))[0];
 let deep:unknown=['x'];for(let i=0;i<102;i++)deep=[{ref:strong.id,parts:deep}];expect(()=>nested.fromParts(target.id,deep)).toThrow();
});
