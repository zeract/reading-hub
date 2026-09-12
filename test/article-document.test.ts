import {it,expect,vi} from 'vitest';
import {articleDocumentFromHtml,articleDocumentFromMarkdown,articleDocumentMarkdown} from '../src/main/article-document';
import {articleDocumentHtml,validArticleDocument,documentTextNodes} from '../src/shared/article-document';
import {rewriteArticleDocument} from '../src/main/document-rewrite';
import {decodeRewriteResult,encodeRewriteResult} from '../src/main/rewrite-document';
const html='<h2>A heading</h2><p>Read <a href="https://example.com/a">the guide</a> with <strong>care</strong>, <code>x[a]</code> and <span data-reader-tex="x_1">x_1</span>.</p><table><tr><td colspan="2">A cell</td></tr></table><figure><img src="https://example.com/image.png"><figcaption>The chart</figcaption></figure><div class="reader-video"><video controls data-reader-video-sources=\'["https://example.com/v.mp4"]\'></video><button data-reader-video-load="true">加载视频</button></div>';
it('rewrites text only, preserving every structural and asset node and shared HTML presentation',async()=>{
 const doc=articleDocumentFromHtml(html),before=JSON.stringify(doc);const run=vi.fn(async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({id:b.id,text:'中文'+b.text}))}));
 const result=await rewriteArticleDocument(doc,'Fixture',run,new AbortController().signal);
 expect(JSON.stringify(doc)).toBe(before);expect(validArticleDocument(result.content)).toBe(true);expect(run).toHaveBeenCalledTimes(1);
 const translatedIds=new Set(documentTextNodes(doc).map(n=>n.id));const restored=structuredClone(result.content);restored.provenance='source';
 for(const node of documentTextNodes(restored))node.text=node.text.slice(2);
 expect(restored).toEqual(doc);expect(translatedIds.size).toBeGreaterThan(5);
 const rendered=articleDocumentHtml(result.content);expect(rendered).toContain('colspan="2"');expect(rendered).toContain('https://example.com/a');expect(rendered).toContain('x[a]');expect(rendered).toContain('加载视频');expect(rendered).not.toContain('中文加载视频');expect(rendered).not.toContain('中文x_1');
});
it('rejects foreign, missing and duplicate text IDs without saving or accepting model structure',async()=>{
 const doc=articleDocumentFromHtml(html);
 for(const kind of ['missing','duplicate','foreign','html-field']){
  const save=vi.fn();await expect(rewriteArticleDocument(doc,'Fixture',async(_s,p)=>{const blocks=JSON.parse(p).section.blocks;if(kind==='missing')blocks.pop();if(kind==='duplicate')blocks.push(blocks[0]);if(kind==='foreign')blocks[0].id='other';if(kind==='html-field')blocks[0].html='<script>bad</script>';return JSON.stringify({blocks});},new AbortController().signal,undefined,undefined,save)).rejects.toThrow();expect(save).not.toHaveBeenCalled();
 }
});
it('has no raw HTML escape hatch or executable URLs, and model text remains inert',async()=>{
 const doc=articleDocumentFromHtml('<script>alert(1)</script><p onclick="bad()">Text <a href="javascript:bad()">x</a><img src="https://127.0.0.1/x"></p>');
 const result=await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({id:b.id,text:'<img src=x onerror=bad()>'}))}),new AbortController().signal);
 const rendered=articleDocumentHtml(result.content);expect(rendered).not.toContain('javascript:');expect(rendered).not.toContain('127.0.0.1');expect(rendered).not.toContain('<script');expect(rendered).toContain('&lt;img');
});
it('stores new content trees without Markdown duplication and losslessly migrates old drafts',()=>{
 const legacy={markdown:'# 已有中文\n\n[证据](https://example.com/a)',provider:'deepseek',model:'m',createdAt:1,sourceUrl:'https://example.com',sourceTitle:'Title',sourceHash:'x',promptVersion:10};
 const migrated=decodeRewriteResult(JSON.stringify(legacy));expect(migrated.markdown).toBe(legacy.markdown);expect(migrated.content?.provenance).toBe('legacy');expect(decodeRewriteResult(encodeRewriteResult(migrated))).toEqual(migrated);
 const content=articleDocumentFromMarkdown(legacy.markdown);content.provenance='rewrite';const result=decodeRewriteResult(JSON.stringify({...legacy,content,schemaVersion:2,promptVersion:11}));
 const stored=JSON.parse(encodeRewriteResult(result));expect(stored.markdown).toBeUndefined();expect(stored.document).toBeUndefined();expect(decodeRewriteResult(JSON.stringify(stored)).markdown).toBe(articleDocumentMarkdown(content));
 expect(()=>decodeRewriteResult(JSON.stringify({...stored,content:{version:99}}))).toThrow();
});
it('resumes a whole-document checkpoint without model calls and respects cancellation',async()=>{
 const doc=articleDocumentFromHtml(html);let cp:any;
 const result=await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks}),new AbortController().signal,undefined,undefined,p=>cp=p);
 const run=vi.fn();expect((await rewriteArticleDocument(doc,'Fixture',run,new AbortController().signal,undefined,cp)).content).toEqual(result.content);expect(run).not.toHaveBeenCalled();
 const controller=new AbortController();controller.abort();await expect(rewriteArticleDocument(doc,'Fixture',run,controller.signal,undefined,cp)).rejects.toThrow();
});

it('allows explicit empty translations for grammar but never missing IDs or empty paragraphs/anchors',async()=>{
 const doc=articleDocumentFromHtml('<p>The <a href="https://example.com/a">guide</a>.</p>');
 const r=await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({id:b.id,text:b.text==='The '?'':b.text==='guide'?'指南':b.text}))}),new AbortController().signal);
 expect(articleDocumentHtml(r.content)).toContain('>指南</a>');
 await expect(rewriteArticleDocument(doc,'Fixture',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({id:b.id,text:''}))}),new AbortController().signal)).rejects.toThrow('变空');
});
it('provides ordered text IDs and immutable code between fragments as model context',async()=>{
 const doc=articleDocumentFromHtml('<p>Before <code>x.md</code>, after.</p>');
 await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>{const input=JSON.parse(p);expect(input.context.map((x:any)=>x.kind)).toEqual(['text','code','text']);expect(input.context[0].id).toBe(input.section.blocks[0].id);return JSON.stringify({blocks:input.section.blocks});},new AbortController().signal);
});

it('repairs an omitted node once by replacing its whole paragraph, without duplicating merged text',async()=>{
 const doc=articleDocumentFromHtml('<p>Before <code>x</code>, after.</p><p>Independent.</p>');let calls=0;const inputs:any[]=[];
 const r=await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>{
  const v=JSON.parse(p);inputs.push(v);calls++;
  if(calls===1)return JSON.stringify({blocks:v.section.blocks.filter((_:any,i:number)=>i!==1).map((b:any,i:number)=>({...b,text:i===0?'错误合并的句子':'独立段落。'}))});
  return JSON.stringify({blocks:v.section.blocks.map((b:any,i:number)=>({...b,text:i===0?'在前':'，在后。'}))});
 },new AbortController().signal);
 expect(calls).toBe(2);expect(inputs[1].section.blocks).toHaveLength(2);expect(articleDocumentHtml(r.content)).toContain('在前<code>x</code>，在后。');expect(articleDocumentHtml(r.content)).not.toContain('错误合并');expect(r.quality.repairedSections).toBe(1);
});
it('keeps indivisible paragraphs together at a unit boundary and requires no model for asset-only documents',async()=>{
 const {documentRewriteUnits}=await import('../src/main/document-rewrite');const doc=articleDocumentFromHtml(Array.from({length:50},()=>'<p>a <b>b</b> c</p>').join(''));
 const units=documentRewriteUnits(doc);expect(units.every(unit=>unit.length%3===0)).toBe(true);
 const run=vi.fn();const fixed=articleDocumentFromHtml('<pre>code</pre>');expect((await rewriteArticleDocument(fixed,'Fixture',run,new AbortController().signal)).content.children).toEqual(fixed.children);expect(run).not.toHaveBeenCalled();
});

it('normalizes preview cards once and keeps their title, metadata and cover in both versions',async()=>{
 const url='https://example.com/post',card=`<div><a href="${url}">${url}</a><div><a href="${url}"><img src="https://example.com/cover.png"></a><div><a href="${url}"><h4>The report</h4></a><a href="https://example.com/author">Author</a><div>September 29, 2025</div><a href="${url}">Read full story</a></div></div></div>`;
 const doc=articleDocumentFromHtml(card);expect(doc.children[0].type).toBe('card');
 const r=await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({...b,text:'报告'}))}),new AbortController().signal);
 const rendered=articleDocumentHtml(r.content);expect(rendered).toContain('reader-link-card');expect(rendered).toContain('>报告</a>');expect(rendered).toContain('Author');expect(rendered).toContain('September 29, 2025');expect(rendered.match(/<img/g)).toHaveLength(1);expect(rendered).not.toContain('Read full story');
});
it('keeps source identity stable when derived formula markup changes',async()=>{
 const {structuredSourceHash}=await import('../src/main/document-rewrite');
 const first=articleDocumentFromHtml('<p>Before <span data-reader-tex="x"><span id="render-1">x</span></span> after.</p>');
 const second=articleDocumentFromHtml('<p>Before <span data-reader-tex="x"><span id="render-2"><span>x</span></span></span> after.</p>');
 expect(documentTextNodes(first)).toEqual(documentTextNodes(second));expect(structuredSourceHash(first)).toBe(structuredSourceHash(second));
 expect(structuredSourceHash(articleDocumentFromHtml('<p>Before <span data-reader-tex="y">y</span> after.</p>'))).not.toBe(structuredSourceHash(first));
});

it('retains a transient sanitized import for old checkpoint hashing without making it the displayed document',async()=>{
 const {withArticleDocument}=await import('../src/main/article-document');
 const a=withArticleDocument({entryId:'one',url:'https://example.com',title:'Title',renderProfile:'standard',contentHtml:html});
 expect(a.importHtml).toBe(html);expect(a.document).toBeDefined();expect(a.contentHtml).toBe(articleDocumentHtml(a.document!));expect(withArticleDocument(a).importHtml).toBe(html);
});

it('bounds read-only asset context without requesting or altering the assets',async()=>{
 const doc=articleDocumentFromHtml('<p>Before.</p>'+Array.from({length:150},()=>'<pre>'+('literal '.repeat(80))+'</pre>').join('')+'<p>After.</p>');
 const result=await rewriteArticleDocument(doc,'Fixture',async(_s,p)=>{expect(p.length).toBeLessThan(30000);const input=JSON.parse(p);expect(input.section.blocks).toHaveLength(2);return JSON.stringify({blocks:input.section.blocks});},new AbortController().signal);
 expect(result.content.children.filter(n=>n.type==='asset')).toHaveLength(150);
});

it('preserves existing public HTTP media without widening private-network access',async()=>{
 const {withArticleDocument}=await import('../src/main/article-document');
 const article=withArticleDocument({entryId:'one',url:'https://example.com',title:'Title',renderProfile:'standard',coverImageUrl:'http://example.com/cover.png',contentHtml:'<p>Text</p>'});
 expect(article.contentHtml).toContain('src="http://example.com/cover.png"');expect(articleDocumentHtml(articleDocumentFromHtml('<img src="http://example.com/image.png">'))).toContain('src="http://example.com/image.png"');expect(articleDocumentHtml(articleDocumentFromHtml('<img src="http://127.0.0.1/image.png">'))).not.toContain('127.0.0.1');
});
