import {it,expect,vi} from 'vitest';
import {parseRewriteResponse} from '../src/main/rewrite-response';
import {rewriteArticleDocument,type DocumentCheckpoint} from '../src/main/document-rewrite';
import {articleDocumentFromHtml} from '../src/main/article-document';
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
