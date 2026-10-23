import {it,expect,vi} from 'vitest';
import {parseRewriteResponse} from '../src/main/rewrite-response';
import {rewriteArticleDocument,type DocumentCheckpoint} from '../src/main/document-rewrite';
import {articleDocumentFromHtml} from '../src/main/article-document';
import {parseTextPatch,TextPatchValidationError} from '../src/main/rewrite-text-patch';
it.each(['raw','json','bare','tilde','long'])('accepts complete %s envelopes without modifying strings',kind=>{
 const json=JSON.stringify({blocks:[{id:'x',text:'中文 "quote" C:\\path\n```code```'}]});
 const text=kind==='raw'?'\ufeff'+json:kind==='json'?'```JSON\r\n'+json+'\r\n```':kind==='bare'?'```\n'+json+'\n```':kind==='tilde'?'~~~json\n'+json+'\n~~~':'````json\n'+json+'\n````';
 expect(parseRewriteResponse(text)).toEqual(JSON.parse(json));
});
it.each(['Explanation\n{"blocks":[]}','{"blocks":[]}\nThanks','```json\n{"blocks":[]}','```js\n{"blocks":[]}\n```','{"text":"\\q"}','{"blocks":[','{"blocks":[]} {"blocks":[]}'])('rejects non-complete payload %s',raw=>expect(()=>parseRewriteResponse(raw)).toThrow());
it('retries only a malformed current section, preserving the successful checkpoint',async()=>{
 const doc=articleDocumentFromHtml('<p>'+('First sentence. '.repeat(340))+'</p><p>'+('Second sentence. '.repeat(300))+'</p>');let cp:DocumentCheckpoint|undefined;
 const first=vi.fn(async(_s:string,p:string)=>{const v=JSON.parse(p);if(v.section.id==='S2')return '{bad';return JSON.stringify({blocks:v.section.blocks});});
 await expect(rewriteArticleDocument(doc,'Title',first,new AbortController().signal,undefined,undefined,c=>cp=c,true)).rejects.toThrow('重试本节一次');expect(cp?.patches).toHaveLength(1);expect(first).toHaveBeenCalledTimes(3);
 const second=vi.fn(async(_s:string,p:string)=>{const v=JSON.parse(p);expect(v.section.id).toBe('S2');return JSON.stringify({blocks:v.section.blocks});});
 await rewriteArticleDocument(doc,'Title',second,new AbortController().signal,undefined,cp,undefined,true);expect(second).toHaveBeenCalledTimes(1);
});
it('shares the retry budget with reference repair and never retries transport failures',async()=>{
 const doc=articleDocumentFromHtml('<p>See <a href="https://example.com">guide</a>.</p>');
 const run=vi.fn(async(_s:string,p:string)=>run.mock.calls.length===1?'{bad':JSON.stringify({blocks:JSON.parse(p).section.blocks.map((b:any)=>({...b,text:b.text.replace(/⟦[^⟧]+⟧/g,'')}))}));
 await expect(rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined,true)).rejects.toThrow();expect(run).toHaveBeenCalledTimes(2);
 const disconnected=vi.fn(async()=>{throw Error('connection incomplete');});await expect(rewriteArticleDocument(doc,'Title',disconnected,new AbortController().signal)).rejects.toThrow('connection incomplete');expect(disconnected).toHaveBeenCalledTimes(1);
});
it.each(['duplicate','unknown-node','text-type','node-shape','text-length','response-shape','invalid-record'])('recovers a complete response with %s within the same section budget',async reason=>{
 const doc=articleDocumentFromHtml('<p>First paragraph.</p><p>Second paragraph.</p>');
 let first:any;
 const run=vi.fn(async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length>1){
   expect(input.repair.issues[0].reason).toBe(reason==='invalid-record'?'node-shape':reason);
   expect(JSON.stringify(input.repair)).not.toContain('private-model-message');
   expect(input.section.blocks).toHaveLength(['unknown-node','response-shape','invalid-record'].includes(reason)?3:1);
   return JSON.stringify({blocks:input.section.blocks});
  }
  first=input;const blocks=input.section.blocks.map((b:any)=>({...b})),target=blocks[1];
  if(reason==='duplicate')blocks.push({...target});
  if(reason==='unknown-node')blocks.push({id:'private-model-message',text:'Extra'});
  if(reason==='text-type')target.text=123;
  if(reason==='node-shape')target.extra='private-model-message';
  if(reason==='text-length')target.text='x'.repeat(2001);
  if(reason==='invalid-record')blocks.push(null);
  return JSON.stringify(reason==='response-shape'?{items:blocks}:{blocks});
 });
 const result=await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);
 expect(first.section.blocks).toHaveLength(3);expect(run).toHaveBeenCalledTimes(2);expect(result.quality.repairedSections).toBe(1);
});
it('combines invalid known nodes with missing blocks and malformed references, without choosing a duplicate winner',async()=>{
 const doc=articleDocumentFromHtml('<p>Duplicate paragraph.</p><p>Missing paragraph.</p><p>A <a href="https://example.com">link</a> and <code>x</code>.</p><p>Keep this translation.</p>');
 const run=vi.fn(async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length===1){
   const blocks=input.section.blocks.filter((b:any)=>b.text!=='Missing paragraph.').map((b:any)=>({...b,text:b.text==='Keep this translation.'?'保留已成功译文。':b.text.replace(/⟦[^⟧]+\/⟧/,'')}));
   blocks.push({...blocks[1],text:'Never select this duplicate.'});return JSON.stringify({blocks});
  }
  expect(input.section.blocks).toHaveLength(3);expect(input.repair.issues.map((i:any)=>i.reason)).toEqual(['duplicate','missing','missing']);
  return JSON.stringify({blocks:input.section.blocks});
 });
 const result=await rewriteArticleDocument(doc,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);
 expect(JSON.stringify(result.content)).toContain('保留已成功译文。');expect(JSON.stringify(result.content)).not.toContain('Never select');expect(run).toHaveBeenCalledTimes(2);
});
it('removes all duplicate candidates and emits only source-owned diagnostics',()=>{
 const nodes=[{type:'text' as const,id:'N1',text:'Original'},{type:'text' as const,id:'N2',text:'Other'}];
 const raw=JSON.stringify({blocks:[{id:'N1',text:'first'},{id:'N1',text:'last'},{id:'N2',text:'valid'},{id:'private-unknown',text:'private-body'}]});
 try{parseTextPatch(raw,nodes);throw new Error('Expected rejection');}catch(error){
  expect(error).toBeInstanceOf(TextPatchValidationError);
  const failed=error as TextPatchValidationError;
  expect(failed.patch).toEqual({N2:'valid'});expect(failed.scope).toBe('section');
  expect(failed.issues).toEqual([{paragraph:'section',reference:'unknown',reason:'unknown-node'},{paragraph:'N1',reference:'paragraph',reason:'duplicate'}]);
  expect(JSON.stringify(failed)).not.toContain('private-');expect(failed.message).not.toContain('private-');
 }
 expect(parseTextPatch(JSON.stringify({blocks:[{id:'N2',text:'二'},{id:'N1',text:'一'}]}),nodes)).toEqual({N1:'一',N2:'二'});
});
it('includes known reference failures in feedback even when unknown records require a whole-section retry',async()=>{
 const source=articleDocumentFromHtml('<p>Use <a href="https://example.com">this guide</a>.</p><p>Another paragraph.</p>');
 const run=vi.fn(async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length===1){const link=input.references[0];return JSON.stringify({blocks:[...input.section.blocks.map((b:any)=>({...b,text:b.text.replace(link.close,'')})),{id:'unknown',text:'bad'}]});}
  expect(input.section.blocks).toHaveLength(3);expect(input.repair.issues.map((issue:any)=>issue.reason)).toEqual(['unknown-node','unclosed']);
  return JSON.stringify({blocks:input.section.blocks});
 });
 await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);
 expect(run).toHaveBeenCalledTimes(2);
});
it('regenerates source-owned missing slots rather than guessing the meaning of an unknown replacement',async()=>{
 const source=articleDocumentFromHtml('<p>Missing target.</p><p>Use <a href="https://example.com">the guide</a>.</p><p>Keep successful text.</p>');
 let missingId='';
 const run=vi.fn(async(_stage:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length===1){
   missingId=input.section.blocks.find((b:any)=>b.text==='Missing target.').id;
   const link=input.references[0];
   return JSON.stringify({blocks:input.section.blocks.map((b:any)=>b.id===missingId?{id:'private-unknown',text:'Do not use or map this text.'}:{...b,text:b.text==='Keep successful text.'?'保留正确译文。':b.text.replace(link.close,'')})});
  }
  expect(input.section.blocks).toHaveLength(2);
  expect(input.section.blocks.map((b:any)=>b.text)).toContain('Missing target.');
  expect(input.repair.issues.map((issue:any)=>issue.reason)).toEqual(['unknown-node','missing','unclosed']);
  expect(JSON.stringify(input)).not.toContain('Do not use or map');expect(JSON.stringify(input)).not.toContain('private-unknown');
  return JSON.stringify({blocks:input.section.blocks});
 });
 const output=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,undefined,true);
 expect(JSON.stringify(output.content)).toContain('保留正确译文。');expect(run).toHaveBeenCalledTimes(2);
});
it.each(['unknown-node','duplicate','text-type','text-length'])('stops after one recovery even if the next response has %s',async reason=>{
 const source=articleDocumentFromHtml('<p>Example.</p>');
 const run=vi.fn(async(_s:string,prompt:string)=>{
  const input=JSON.parse(prompt);
  if(run.mock.calls.length===1)return '{bad';
  const blocks=input.section.blocks.map((b:any)=>({...b}));
  if(reason==='unknown-node')blocks.push({id:'private-secret',text:'bad'});
  else if(reason==='duplicate')blocks.push({...blocks[0]});
  else blocks[0].text=reason==='text-type'?null:'x'.repeat(2001);
  return JSON.stringify({blocks});
 });
 const save=vi.fn();
 await expect(rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,undefined,save,true)).rejects.toThrow(reason);
 expect(run).toHaveBeenCalledTimes(2);expect(save).not.toHaveBeenCalled();
});
it('cancels a pending recovery without saving a late valid response',async()=>{
 const controller=new AbortController(),save=vi.fn();
 const run=vi.fn(async(_s:string,p:string)=>{
  const input=JSON.parse(p);if(run.mock.calls.length===1)return JSON.stringify({blocks:[{id:'unknown',text:'bad'}]});
  controller.abort();return JSON.stringify({blocks:input.section.blocks});
 });
 await expect(rewriteArticleDocument(articleDocumentFromHtml('<p>Example.</p>'),'Title',run,controller.signal,undefined,undefined,save,true)).rejects.toThrow();
 expect(run).toHaveBeenCalledTimes(2);expect(save).not.toHaveBeenCalled();
});
it('resumes section five of six, recovering unknown IDs without replaying the first four sections',async()=>{
 const source=articleDocumentFromHtml(Array.from({length:6},(_,i)=>`<p>Section ${i+1}. ${'An example paragraph. '.repeat(240)}</p>`).join(''));
 let checkpoint:DocumentCheckpoint|undefined;
 const failing=async(_s:string,prompt:string)=>{const input=JSON.parse(prompt);return JSON.stringify(input.section.id==='S5'?{blocks:[{id:'unknown',text:'bad'}]}:{blocks:input.section.blocks});};
 await expect(rewriteArticleDocument(source,'Title',failing,new AbortController().signal,undefined,undefined,c=>checkpoint=c,true,13)).rejects.toThrow('第 5/6 节');
 expect(checkpoint?.patches).toHaveLength(4);const previous=structuredClone(checkpoint!);
 const run=vi.fn(async(_s:string,prompt:string)=>{
  const input=JSON.parse(prompt);expect(['S5','S6']).toContain(input.section.id);
  return JSON.stringify(input.section.id==='S5'&&!input.repair?{blocks:[{id:'unknown',text:'bad'}]}:{blocks:input.section.blocks});
 });
 const result=await rewriteArticleDocument(source,'Title',run,new AbortController().signal,undefined,checkpoint,c=>checkpoint=c,true,13);
 expect(run).toHaveBeenCalledTimes(3);expect(result.quality.repairedSections).toBe(1);expect(checkpoint?.patches).toHaveLength(6);
 expect(checkpoint?.patches.slice(0,4)).toEqual(previous.patches);
});
