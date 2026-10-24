import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArticleReader } from "../src/main/article-reader";
import { ArticleLibrary } from "../src/main/article-library";
import { ReadingDatabase } from "../src/main/database";
import { contentNormalizer } from "../src/main/content-normalizer";
import { AccessChallengeError } from "../src/main/access-challenge";
import type { Entry, Source } from "../src/shared/types";

const source = {id:'s',url:'https://example.com/blog',kind:'generic',title:'Fixture'} as Source;
const entry = {id:'e',sourceId:'s',url:'https://publisher.example/post',canonicalUrl:'https://publisher.example/post',title:'Fixture'} as Entry;
const prose='A complete supplied body with structure and source context. '.repeat(20);
const response=(url:string,text:string)=>({url,text,status:200,contentType:'text/html'});
const feed=(body?:string,url=entry.url)=>`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title><item><title>Fixture</title><link>${url}</link><description>A bounded introduction to this article, explicitly a description.</description>${body?`<content:encoded><![CDATA[${body}]]></content:encoded>`:''}</item></channel></rss>`;
afterEach(()=>vi.useRealTimers());
function fixture(configured=false,body=`<p>${prose}</p>`,itemUrl=entry.url){
 const s=configured?{...source,extractionRule:{version:1 as const,feedUrl:'https://feeds.example/articles.xml'}}:source;
 const http={getText:vi.fn(async(url:string)=>{
  if(url===entry.url)throw new AccessChallengeError();
  if(url===source.url)return response(url,'<main>Article index without feed declaration</main>');
  if(url==='https://example.com/')return response(url,'<link rel="alternate" type="application/rss+xml" href="https://feeds.example/articles.xml">');
  if(url==='https://feeds.example/articles.xml')return response(url,feed(body,itemUrl));
  throw new Error('Unexpected request');
 })};
 const renderer={render:vi.fn()};return {http,s,renderer,reader:new ArticleReader(http as never,renderer)};
}
it.each([false,true])('reads a matching declared Feed for a generic subscription (configured=%s)',async configured=>{
 const f=fixture(configured);const a=await f.reader.read(entry,f.s);
 expect(a.contentMode).toBe('feed_body');expect(a.contentHtml).toContain(prose);expect(f.renderer.render).not.toHaveBeenCalled();
 if(configured)expect(f.http.getText.mock.calls.map(x=>x[0])).toEqual([entry.url,'https://feeds.example/articles.xml']);
});
it('caches only positive declared Feed addresses and still rechecks the Feed for the requested entry',async()=>{
 const f=fixture();await f.reader.read(entry,f.s);await f.reader.read(entry,f.s);
 expect(f.http.getText.mock.calls.filter(x=>x[0]===source.url)).toHaveLength(1);
 expect(f.http.getText.mock.calls.filter(x=>x[0]==='https://example.com/')).toHaveLength(1);
 expect(f.http.getText.mock.calls.filter(x=>x[0]==='https://feeds.example/articles.xml')).toHaveLength(2);
});
it('keeps a plain RSS description as summary, never as a stored body',async()=>{
 const f=fixture(false,'');const article=await f.reader.read(entry,f.s);
 expect(article.contentMode).toBe('feed_summary');expect(article.contentHtml).toContain('bounded introduction');
 const db=new ReadingDatabase(':memory:');try{expect(db.articles.save(entry.id,article)).toBe(false);}finally{db.close();}
});
it('does not attach a different Feed entry by title or ignore identity-bearing query parameters',async()=>{
 const f=fixture(false,`<p>${prose}</p>`,entry.url+'?edition=other');
 await expect(f.reader.read(entry,f.s)).rejects.toBeInstanceOf(AccessChallengeError);
 expect(f.renderer.render).not.toHaveBeenCalled();
});
it('does not fetch arbitrary Feed addresses for manual, academic or authorized sources',async()=>{
 for(const kind of ['manual','academic','zhihu_follow'] as const){const f=fixture();await expect(f.reader.read(entry,{...f.s,kind})).rejects.toBeInstanceOf(AccessChallengeError);expect(f.http.getText).toHaveBeenCalledOnce();}
});
it('bounds all Feed discovery together and rejects late metadata after cancellation',async()=>{
 vi.useFakeTimers();const f=fixture();let finish!:(value:any)=>void;
 f.http.getText.mockImplementation(async url=>{if(url===entry.url)throw new AccessChallengeError();return new Promise(resolve=>{finish=resolve;});});
 const result=f.reader.read(entry,f.s).catch(e=>e);await vi.advanceTimersByTimeAsync(20_000);
 expect(await result).toBeInstanceOf(AccessChallengeError);
 finish(response(source.url,'<link type="application/rss+xml" href="https://feeds.example/late">'));
 await vi.advanceTimersByTimeAsync(0);expect(f.reader['declaredFeedCache'].get(source.url)).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
});
it('saves a read-time generic Feed body and its images, then reopens offline after Feed removal and restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'generic-feed-restart-')),path=join(directory,'library.sqlite');
 let db=new ReadingDatabase(path);const s=db.createSource({url:source.url,title:'Fixture',kind:'generic',pollingEnabled:true});
 const e=contentNormalizer.normalize({url:entry.url,title:entry.title},s);db.saveEntries([e]);const stored=db.listEntries(s.id)[0];
 const f=fixture(false,`<p>${prose}</p><img src="https://feeds.example/image.png">`);
 const image='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
 const http={...f.http,getImageDataUrl:vi.fn(async()=>image)};
 let library=new ArticleLibrary(db,new ArticleReader(http as never,f.renderer),http as never);
 try{const article=await library.read(stored,s);expect(article.savedAt).toBeUndefined();await library.loadImage(stored,'https://feeds.example/image.png');expect(db.articles.read(stored.id)).toBeDefined();await library.close();db.close();
 db=new ReadingDatabase(path);const offline={getText:vi.fn(async()=>{throw new Error('Offline and removed Feed');}),getImageDataUrl:vi.fn(async()=>{throw new Error('Offline image');})};
 library=new ArticleLibrary(db,new ArticleReader(offline as never,{render:vi.fn()}),offline as never);
 expect((await library.read(stored,s)).contentHtml).toContain(prose);
 expect(await library.loadImage(stored,'https://feeds.example/image.png')).toBe(image);
 expect(offline.getText).not.toHaveBeenCalled();expect(offline.getImageDataUrl).not.toHaveBeenCalled();
 }finally{await library.close();db.close();rmSync(directory,{recursive:true,force:true});}
});
