import {createHash} from "node:crypto";
import {rewriteText} from "../src/main/rewrite-content";
import { REWRITE_PROMPT_VERSION } from "../src/main/rewrite-content";
import { rewriteModelResponse } from "./support/rewrite-model";
import { afterEach, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { RewriteService } from "../src/main/rewrite-service";
import { AiServiceError } from "../src/main/ai-service";
import type { Entry, ReaderArticle } from "../src/shared/types";
import type { RewriteSettings } from "../src/shared/rewrite";
import { parseRewriteSettings } from "../src/shared/rewrite";
const settings:RewriteSettings={provider:"deepseek",model:"future-rewrite-model",effort:"default"};
const text="A paragraph about memory and the evidence supporting the author's conclusion. ".repeat(12);
const live:Array<{db:ReadingDatabase;service:RewriteService}>=[];
afterEach(async()=>{for(const {db,service} of live.splice(0)){await service.close();db.close();}});
function fixture() {
 const db=new ReadingDatabase(":memory:");const source=db.createSource({url:"https://example.com/feed",title:"Fixture",kind:"rss",pollingEnabled:true});
 const entry:Entry={id:"entry",sourceId:source.id,title:"Original",url:"https://example.com/post",canonicalUrl:"https://example.com/post",contentHash:"old",read:false,favorite:true,createdAt:1};db.saveEntries([entry]);
 const article:ReaderArticle={entryId:entry.id,url:entry.url,title:entry.title,renderProfile:"standard",contentHtml:`<p>${text}</p>`};
 const read=vi.fn(async()=>article);const rewriteChunk=vi.fn(async(_settings, prompt, _signal, stage)=>({provider:"deepseek" as const,model:settings.model,text:stage==="write" ? JSON.stringify({blocks:JSON.parse(prompt).section.blocks.map((b:any)=>({id:b.id,text:"对应中文改写内容。"}))}) : rewriteModelResponse(prompt,stage)}));
 const service=new RewriteService(db,{read},{rewriteChunk});live.push({db,service});service.configure(settings);
 return {db,source,entry,article,read,rewriteChunk,service};
}
it("queues immediately, deduplicates double clicks, and stores only derived content with provenance",async()=>{
 const f=fixture();let finish!:(value:ReaderArticle)=>void;f.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));f.service.start();
 const one=f.service.enqueue("entry");const two=f.service.enqueue("entry");expect(two.jobId).toBe(one.jobId);expect(one.status).toBe("queued");
 await vi.waitFor(()=>expect(f.read).toHaveBeenCalledTimes(1));finish(f.article);
 await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 expect(f.rewriteChunk).toHaveBeenCalledTimes(1);expect(f.db.getEntry("entry")?.title).toBe("Original");
 expect(f.db.rewrites.get("entry")?.result).toMatchObject({sourceUrl:f.entry.url,sourceTitle:"Original",model:settings.model,promptVersion:REWRITE_PROMPT_VERSION});
 expect(JSON.stringify(f.db.rewrites.get("entry"))).not.toContain(text);
});
it("preserves a completed draft on failed regeneration, with a snapshotted model",async()=>{
 const f=fixture();f.service.start();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 const result=f.db.rewrites.get("entry")!.result;
 f.rewriteChunk.mockRejectedValueOnce(new AiServiceError("模型请求超时。"));f.service.enqueue("entry");f.service.configure({...settings,model:"different"});
 await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));
 expect(f.db.rewrites.get("entry")?.result).toEqual(result);expect(f.rewriteChunk.mock.calls.at(-1)![0].model).toBe(settings.model);
});
it("cancels a running job and rejects late output even after re-enqueuing",async()=>{
 const f=fixture();let finish!:(value:any)=>void;f.rewriteChunk.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));f.service.start();f.service.enqueue("entry");
 await vi.waitFor(()=>expect(f.rewriteChunk).toHaveBeenCalledTimes(1));expect(f.db.rewrites.get("entry")?.stage).toBe("write");f.service.cancel("entry");expect(f.db.rewrites.get("entry")?.status).toBe("cancelled");
 const second=f.service.enqueue("entry");finish({provider:"deepseek",model:"late",text:"late content"});
 await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));expect(f.db.rewrites.get("entry")?.jobId).toBe(second.jobId);expect(f.db.rewrites.get("entry")?.result?.model).not.toBe("late");
});
it("shutdown drains accepted work, keeps queued requests, and rejects new work",async()=>{
 const f=fixture();f.service.start();f.read.mockImplementation((_entry,_source,options)=>new Promise((_,reject)=>options?.signal?.addEventListener("abort",()=>reject(new Error("aborted")),{once:true})));
 f.db.saveEntries([{...f.entry,id:"waiting",url:"https://example.com/waiting",canonicalUrl:"https://example.com/waiting"}]);
 f.service.enqueue("entry");f.service.enqueue("waiting");await vi.waitFor(()=>expect(f.read).toHaveBeenCalled());await f.service.close();
 expect(f.db.rewrites.get("waiting")?.status).toBe("queued");
 expect(f.db.rewrites.get("entry")?.status).toBe("failed");expect(()=>f.service.enqueue("entry")).toThrow("退出");expect(f.db.getEntry("entry")).toBeDefined();
});
it("recovers interrupted jobs as retryable without sending them again, resumes queued jobs",async()=>{
 const f=fixture();const job=f.service.enqueue("entry");f.db.rewrites.progress(job,1,3);f.service.start();
 await new Promise(resolve=>setTimeout(resolve,10));expect(f.db.rewrites.get("entry")?.status).toBe("failed");expect(f.rewriteChunk).not.toHaveBeenCalled();
 f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
});
it("cascades deleted article drafts and prevents late output recreating them",async()=>{
 const f=fixture();let finish!:(value:any)=>void;f.rewriteChunk.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));f.service.start();f.service.enqueue("entry");
 await vi.waitFor(()=>expect(f.rewriteChunk).toHaveBeenCalled());f.db.deleteSource(f.source.id);f.db.publishChanges();finish({provider:"deepseek",model:"late",text:"late"});await f.service.close();
 expect(f.db.rewrites.get("entry")).toBeUndefined();expect(f.db.getEntry("entry")).toBeUndefined();
});
it("uses bounded complete chunks and does not expose remote errors",async()=>{
 const f=fixture();f.article.contentHtml=Array.from({length:18},()=>`<p>${text}</p>`).join("");f.service.start();f.service.enqueue("entry");
 await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));expect(f.rewriteChunk.mock.calls.length).toBeGreaterThan(1);
 expect(f.rewriteChunk.mock.calls.map(c=>c[1]).join("")).toContain("S2");
 f.rewriteChunk.mockRejectedValueOnce(new Error("secret remote details"));f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));expect(f.db.rewrites.get("entry")?.error).not.toContain("secret");
});
it("rejects malformed settings without persisting extra credential fields",()=>{
 const f=fixture();expect(()=>parseRewriteSettings({...settings,model:"a\nsecret"})).toThrow();
 f.service.configure({...settings,apiKey:"never-store"} as RewriteSettings);expect(JSON.stringify(f.db.rewrites.settings())).not.toContain("never-store");
});
it("rejects a capped answer instead of marking an incomplete rewrite complete",async()=>{
 const f=fixture();f.rewriteChunk.mockResolvedValue({provider:"deepseek",model:"future",text:"中".repeat(40000)});f.service.enqueue("entry");f.service.start();
 await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));expect(f.db.rewrites.get("entry")?.result).toBeUndefined();
});

it("resumes completed sections after a failed request without resending them",async()=>{
 const f=fixture();f.article.contentHtml=Array.from({length:18},()=>`<p>${text}</p>`).join("");
 f.rewriteChunk.mockImplementationOnce(async(_s,p,_a,stage)=>({provider:"deepseek",model:settings.model,text:rewriteModelResponse(p,stage)})).mockRejectedValueOnce(new Error("network"));
 f.service.start();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));
 expect(f.db.rewrites.get("entry")?.result).toBeUndefined();
 f.rewriteChunk.mockClear();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 expect(JSON.parse(f.rewriteChunk.mock.calls[0][1]).section.id).toBe("S2");
 f.rewriteChunk.mockClear();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 expect(JSON.parse(f.rewriteChunk.mock.calls[0][1]).section.id).toBe("S1");
});
it("invalidates saved sections when source or configured model changes",async()=>{
 for(const change of ["source","model"]){
  const f=fixture();f.article.contentHtml=Array.from({length:18},()=>`<p>${text}</p>`).join("");
  f.rewriteChunk.mockImplementationOnce(async(_s,p,_a,stage)=>({provider:"deepseek",model:settings.model,text:rewriteModelResponse(p,stage)})).mockRejectedValueOnce(new Error("network"));
  f.service.start();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));
  if(change==="source")f.article.contentHtml+="<p>New facts.</p>";else f.service.configure({...settings,model:"changed"});
  f.rewriteChunk.mockClear();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
  expect(JSON.parse(f.rewriteChunk.mock.calls[0][1]).section.id).toBe("S1");
 }
});
it("optional review saves cohesion advice without replacing or hiding the completed text",async()=>{
 const f=fixture();f.service.start();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 const saved=f.db.rewrites.get("entry")!.result!;
 f.rewriteChunk.mockImplementation(async(_s,p)=>{const input=JSON.parse(p);return {provider:"deepseek",model:"review-model",text:JSON.stringify({coverage:input.section.blocks.map(b=>({blockId:b.id,covered:true})),issues:[{blockId:input.section.blocks[0].id,kind:"cohesion",message:"过渡可更自然",sourceQuote:""}]})};});
 f.service.enqueue("entry","review");expect(f.db.rewrites.get("entry")?.result?.markdown).toBe(saved.markdown);
 await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 const result=f.db.rewrites.get("entry")!.result!;expect(result.markdown).toBe(saved.markdown);expect(result.createdAt).toBe(saved.createdAt);
 expect(result.review?.issues).toHaveLength(1);expect(result.review?.model).toBe("review-model");
 f.rewriteChunk.mockRejectedValue(new Error("network"));f.service.enqueue("entry","review");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));expect(f.db.rewrites.get("entry")?.result).toEqual(result);
});
it("does not send changed source to compare against an older draft",async()=>{
 const f=fixture();f.service.start();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 f.article.contentHtml+="<p>Changed.</p>";f.rewriteChunk.mockClear();f.service.enqueue("entry","review");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));
 expect(f.rewriteChunk).not.toHaveBeenCalled();expect(f.db.rewrites.get("entry")?.error).toContain("原文已变化");expect(f.db.rewrites.get("entry")?.result).toBeDefined();
});
it("migrates old results with a cascade-owned backup and skips malformed queued jobs",async()=>{
 const f=fixture();const job=f.service.enqueue("entry");f.db.rewrites.progress(job,1,1);
 const raw={markdown:"旧稿 [链接](https://example.com/link)",provider:"deepseek",model:"model",createdAt:1,sourceUrl:f.entry.url,sourceTitle:"Title",sourceHash:"hash",promptVersion:7};
 const sql=(f.db as any).db;
 sql.prepare("UPDATE article_rewrites SET status='complete',result_json=? WHERE entry_id=?").run(JSON.stringify(raw),"entry");
 const migrated=f.db.rewrites.get("entry")!.result!;expect(migrated.schemaVersion).toBe(2);expect(migrated.markdown).toBe(raw.markdown);
 expect(sql.prepare("SELECT result_json FROM rewrite_migration_backups WHERE entry_id='entry'").get().result_json).toBe(JSON.stringify(raw));
 f.db.rewrites.get("entry");expect(sql.prepare("SELECT COUNT(*) AS count FROM rewrite_migration_backups").get().count).toBe(1);
 sql.prepare("UPDATE article_rewrites SET status='queued',settings_json='{' WHERE entry_id='entry'").run();
 f.db.saveEntries([{...f.entry,id:"next",url:"https://example.com/next",canonicalUrl:"https://example.com/next"}]);
 f.service.enqueue("next");expect(f.db.rewrites.next()?.entryId).toBe("next");
 expect(sql.prepare("SELECT status FROM article_rewrites WHERE entry_id='entry'").get().status).toBe("failed");
 f.db.deleteSource(f.source.id);expect(sql.prepare("SELECT COUNT(*) AS count FROM rewrite_migration_backups").get().count).toBe(0);
});

it.each([7,8,9,10])("reuses validated v%s checkpoints after the envelope-only protocol upgrade",async(version)=>{
 const f=fixture();f.article.contentHtml=Array.from({length:3},()=>`<p>${"A detailed explanation of delivery and validation. ".repeat(100)}</p>`).join("");
 let calls=0;f.rewriteChunk.mockImplementation(async(_s,p)=>{if(++calls===2)throw new AiServiceError("stop");return {provider:"deepseek",model:settings.model,text:rewriteModelResponse(p)};});
 f.service.start();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("failed"));
 const sql=(f.db as any).db;const cp={key:"",drafts:["已经完成的旧中文段落。"]};
 const sourceHash=createHash("sha256").update(rewriteText(f.article)).digest("hex");
 cp.key=createHash("sha256").update(JSON.stringify({sourceHash,title:f.article.title,url:f.article.url,settings,version})).digest("hex");
 sql.prepare("UPDATE article_rewrites SET checkpoint_json=? WHERE entry_id='entry'").run(JSON.stringify(cp));
 f.rewriteChunk.mockClear();f.service.enqueue("entry");await vi.waitFor(()=>expect(f.db.rewrites.get("entry")?.status).toBe("complete"));
 expect(JSON.parse(f.rewriteChunk.mock.calls[0][1]).section.id).toBe("S2");expect(f.db.rewrites.get("entry")?.result?.sections?.[0]).toBe(cp.drafts[0]);
});
