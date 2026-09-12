import { expect,it } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadingDatabase } from "../src/main/database";
import type { Entry } from "../src/shared/types";
const settings={provider:"deepseek" as const,model:"future",effort:"default"};
it("persists settings, queued work and completed output across actual database reopen",()=>{
 const dir=mkdtempSync(join(tmpdir(),"rewrite-store-"));const path=join(dir,"library.sqlite");let db=new ReadingDatabase(path);
 try {
  const source=db.createSource({url:"https://example.com/rss",title:"Fixture",kind:"rss",pollingEnabled:true});
  const entry:Entry={id:"fixture",sourceId:source.id,url:"https://example.com/post",canonicalUrl:"https://example.com/post",title:"Fixture",contentHash:"hash",read:true,favorite:true,createdAt:1};
  db.saveEntries([entry,{...entry,id:"queued",url:"https://example.com/queued",canonicalUrl:"https://example.com/queued"}]);db.rewrites.configure(settings);
  const job=db.rewrites.enqueue(entry.id,settings);db.rewrites.progress(job,1,1);db.rewrites.finish(job,{markdown:"本地改写",provider:"deepseek",model:"future",createdAt:2,sourceUrl:entry.url,sourceTitle:entry.title,sourceHash:"hash",promptVersion:1});db.rewrites.enqueue("queued",settings);
  db.close();db=new ReadingDatabase(path);
  expect(db.rewrites.settings()).toEqual(settings);expect(db.rewrites.get(entry.id)?.result?.markdown).toBe("本地改写");expect(db.rewrites.next()?.entryId).toBe("queued");
  const other=db.createSource({url:"https://example.com/other",title:"Other",kind:"rss",pollingEnabled:true});db.saveEntries([{...entry,id:"duplicate",sourceId:other.id}]);
  db.deleteSource(source.id);expect(db.rewrites.get(entry.id)?.result?.markdown).toBe("本地改写");
  db.deleteSource(other.id);expect(db.rewrites.get(entry.id)).toBeUndefined();
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
it("bounds the durable queue and coalesces repeated requests at capacity",()=>{
 const db=new ReadingDatabase(":memory:");try{
 const source=db.createSource({url:"https://example.com/rss",title:"Fixture",kind:"rss",pollingEnabled:true});
 for(let i=0;i<21;i++)db.saveEntries([{id:String(i),sourceId:source.id,url:`https://example.com/${i}`,canonicalUrl:`https://example.com/${i}`,title:"Fixture",contentHash:String(i),read:false,favorite:false,createdAt:i}]);
 for(let i=0;i<20;i++)db.rewrites.enqueue(String(i),settings);
 expect(db.rewrites.enqueue("0",settings).entryId).toBe("0");expect(()=>db.rewrites.enqueue("20",settings)).toThrow("队列已满");
 db.rewrites.cancel("0");expect(db.rewrites.enqueue("20",settings).status).toBe("queued");
 }finally{db.close();}
});

it("keeps checkpoints over restart, isolates keys and jobs, and removes them with the document",()=>{
 const dir=mkdtempSync(join(tmpdir(),"rewrite-resume-"));const path=join(dir,"library.sqlite");let db=new ReadingDatabase(path);
 try {
  const source=db.createSource({url:"https://example.com/rss",title:"Fixture",kind:"rss",pollingEnabled:true});
  db.saveEntries([{id:"entry",sourceId:source.id,url:"https://example.com/post",canonicalUrl:"https://example.com/post",title:"Fixture",contentHash:"hash",read:false,favorite:false,createdAt:1}]);
  const old=db.rewrites.enqueue("entry",settings);db.rewrites.progress(old,1,2,"write");db.rewrites.saveCheckpoint(old,"key",["第一节"]);
  db.close();db=new ReadingDatabase(path);db.rewrites.recover();
  const job=db.rewrites.enqueue("entry",settings);expect(db.rewrites.checkpoint(job,"key")).toEqual(["第一节"]);expect(db.rewrites.checkpoint(job,"changed")).toEqual([]);
  db.rewrites.saveCheckpoint(old,"key",["迟到内容"]);expect(db.rewrites.checkpoint(job,"key")).toEqual(["第一节"]);
  db.rewrites.progress(job,1,2,"write");db.rewrites.cancel("entry");db.rewrites.saveCheckpoint(job,"key",["取消后内容"]);expect(db.rewrites.checkpoint(job,"key")).toEqual(["第一节"]);
  db.rewrites.remove("entry");expect(db.rewrites.checkpoint(job,"key")).toEqual([]);
  db.rewrites.saveCheckpoint(job,"key",["删除后内容"]);expect(db.rewrites.get("entry")).toBeUndefined();
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
