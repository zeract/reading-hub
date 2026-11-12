import { afterAll, beforeAll, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Sqlite from "better-sqlite3";
import { ReadingDatabase } from "../src/main/database";
import { StorageWorkerClient } from "../src/main/storage-worker-client";
import { withArticleDocument } from "../src/main/article-document";

const directory=mkdtempSync(path.join(tmpdir(),"storage-worker-test-")), workerFile=path.join(directory,"worker.cjs");
beforeAll(()=>{
 symlinkSync(path.resolve("node_modules"),path.join(directory,"node_modules"),"dir");
 buildSync({entryPoints:[path.resolve("src/main/storage-worker.ts")],outfile:workerFile,bundle:true,platform:"node",format:"cjs",external:["better-sqlite3"],logLevel:"silent"});
});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));

it("restores missing task indexes even when migrations are already recorded, without changing task state",()=>{
 const file=path.join(directory,"indexes.sqlite");let db=new ReadingDatabase(file);
 const raw=(db as unknown as {db:Sqlite.Database}).db;
 raw.exec("DROP INDEX article_media_pending; DROP INDEX article_acquisitions_pending; DROP INDEX article_documents_quality");
 db.close();db=new ReadingDatabase(file);
 try{
  const native=(db as unknown as {db:Sqlite.Database}).db;
  for(const [query,index] of [
   ["SELECT entry_id,url,referrer,state,attempts FROM article_media WHERE state='pending' AND attempts<3 LIMIT 4","article_media_pending"],
   ["SELECT 1 FROM article_documents INDEXED BY article_documents_quality WHERE entry_id='x' AND variant='' AND quality>=2","article_documents_quality"]]){
   const plan=native.prepare("EXPLAIN QUERY PLAN "+query).all() as {detail:string}[];
   expect(plan.map(p=>p.detail).join(" ")).toContain(index);
  }
  expect(native.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
 }finally{db.close()}
});

it("drains ordered writes on close, preserves owned assets, and cannot resurrect deleted entries",async()=>{
 const file=path.join(directory,"library.sqlite"),db=new ReadingDatabase(file);
 const source=db.createSource({url:"https://example.com/feed",kind:"rss",title:"Feed",pollingEnabled:true});
 const entry={id:"entry",sourceId:source.id,url:"https://example.com/post",canonicalUrl:"https://example.com/post",title:"Body",contentHash:"hash",read:false,favorite:false,createdAt:1};db.saveEntries([entry]);
 const worker=new StorageWorkerClient(file,workerFile);
 const article=withArticleDocument({entryId:entry.id,url:entry.url,title:entry.title,renderProfile:"standard",contentHtml:'<p>Saved body</p><img src="https://example.com/a.png">'});
 try{
  await worker.call("enqueue",entry.id);await worker.call("save",entry.id,article);
  const image="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const saved=worker.call("saveImage",entry.id,"https://example.com/a.png",image);
  const closed=worker.close();await saved;await closed;
  expect(db.articles.image(entry.id,"https://example.com/a.png")).toBe(image);
  expect(db.articles.nextAcquisition()).toBeUndefined();
  const restarted=new StorageWorkerClient(file,workerFile);
  try{
   expect((await restarted.call("read",entry.id))?.document).toEqual(article.document);
   await expect(restarted.call("saveImage",entry.id,entry.url,"invalid")).rejects.toMatchObject({name:"Error",message:"图片不是可保存的安全格式。"});
   db.deleteSource(source.id);
   expect(await restarted.call("save",entry.id,article)).toBe(false);
   expect(await restarted.call("read",entry.id)).toBeUndefined();
  }finally{await restarted.close()}
 }finally{await worker.close();db.close()}
 await expect(worker.call("pendingMedia")).rejects.toThrow("存储工作线程");
});

it("keeps complete startup checks, upgrades only valid libraries, and leaves corrupt files untouched",async()=>{
 const canonical=path.join(directory,"canonical"),file=path.join(canonical,"reading-hub.sqlite");
 const worker=new StorageWorkerClient(undefined,workerFile);
 try{
  expect((await worker.prepare({canonicalDirectory:canonical,legacyDirectories:[]})).kind).toBe("fresh");
  expect((await worker.prepare({canonicalDirectory:canonical,legacyDirectories:[]})).kind).toBe("canonical");
  const db=new Sqlite(file);expect(db.prepare("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});db.close();
  const corrupt=path.join(directory,"corrupt");require("node:fs").mkdirSync(corrupt);const bad=path.join(corrupt,"reading-hub.sqlite");writeFileSync(bad,"not a SQLite database");
  expect((await worker.prepare({canonicalDirectory:corrupt,legacyDirectories:[]})).kind).toBe("blocked");
  expect(readFileSync(bad,"utf8")).toBe("not a SQLite database");
 }finally{await worker.close()}
});

it("isolates an unexpected worker exit and releases every pending waiter",async()=>{
 const failFile=path.join(directory,"exit.cjs");writeFileSync(failFile,"process.exit(2)");
 const worker=new StorageWorkerClient(path.join(directory,"library.sqlite"),failFile);
 const results=await Promise.allSettled([worker.call("pendingMedia"),worker.call("nextAcquisition")]);
 expect(results.every(r=>r.status==='rejected')).toBe(true);
 await expect(worker.close()).rejects.toThrow("本地存储工作线程");
});

it("keeps the host event loop responsive while SQLite waits for a writer, and drains a full admission queue",async()=>{
 const file=path.join(directory,"contention.sqlite"),db=new ReadingDatabase(file);
 const source=db.createSource({url:"https://example.com/contention",kind:"rss",title:"Feed",pollingEnabled:true});
 const entry={id:"contended",sourceId:source.id,url:"https://example.com/contended",canonicalUrl:"https://example.com/contended",title:"Body",contentHash:"h",read:false,favorite:false,createdAt:1};db.saveEntries([entry]);
 const raw=(db as unknown as {db:Sqlite.Database}).db,worker=new StorageWorkerClient(file,workerFile);
 await worker.call("pendingMedia");raw.exec("BEGIN IMMEDIATE");let released=false;
 const release=setTimeout(()=>{raw.exec("COMMIT");released=true},50);
 try{
  await worker.call("save",entry.id,withArticleDocument({entryId:entry.id,url:entry.url,title:entry.title,renderProfile:"standard",contentHtml:"<p>Owned body</p>"}));
  expect(released).toBe(true);
  const admitted=Array.from({length:64},()=>worker.call("pendingMedia"));
  await expect(worker.call("pendingMedia")).rejects.toThrow("繁忙");
  await Promise.all([...admitted,worker.close()]);
  expect(db.articles.hasOriginal(entry.id)).toBe(true);
 }finally{clearTimeout(release);if(raw.inTransaction)raw.exec("ROLLBACK");await worker.close();db.close()}
});

it("blocks foreign-key violations before preparing a library for writes",async()=>{
 const canonical=path.join(directory,"foreign-key"),file=path.join(canonical,"reading-hub.sqlite");require("node:fs").mkdirSync(canonical);
 const db=new ReadingDatabase(file),source=db.createSource({url:"https://example.com/fk",kind:"rss",title:"Feed",pollingEnabled:true});
 db.saveEntries([{id:"fk-entry",sourceId:source.id,url:"https://example.com/fk/post",canonicalUrl:"https://example.com/fk/post",title:"Keep",contentHash:"h",read:false,favorite:false,createdAt:1}]);
 const raw=(db as unknown as {db:Sqlite.Database}).db;raw.pragma("foreign_keys=OFF");raw.exec("UPDATE entries SET source_id='missing' WHERE id='fk-entry'");db.close();
 const worker=new StorageWorkerClient(undefined,workerFile);
 try{const result=await worker.prepare({canonicalDirectory:canonical,legacyDirectories:[]});expect(result.kind).toBe("blocked");const check=new Sqlite(file,{readonly:true});try{expect(check.prepare("SELECT source_id FROM entries WHERE id='fk-entry'").get()).toEqual({source_id:"missing"})}finally{check.close()}}
 finally{await worker.close()}
});

it("serializes foreground mutations and atomic sync commits without blocking the host under a write lock",async()=>{
 const file=path.join(directory,"semantic-writes.sqlite"),db=new ReadingDatabase(file),worker=new StorageWorkerClient(file,workerFile);
 const source=db.createSource({url:"https://example.com/semantic",title:"Feed",kind:"rss",pollingEnabled:true});
 const entry={id:"semantic",sourceId:source.id,url:"https://example.com/semantic/post",canonicalUrl:"https://example.com/semantic/post",title:"Fixture",contentHash:"h",read:false,favorite:false,createdAt:1};db.saveEntries([entry]);
 db.setWriter(worker);await worker.call("pendingMedia");
 const raw=(db as unknown as {db:Sqlite.Database}).db;raw.exec("BEGIN IMMEDIATE");let released=false;
 const timer=setTimeout(()=>{raw.exec("COMMIT");released=true;},60);
 try{
  await db.write("markRead",entry.id,true);expect(released).toBe(true);expect(db.getEntry(entry.id)?.read).toBe(true);
  const subscription=db.getSubscriptionForSource(source.id)!;
  await db.write("commitSync",{source,subscription,outcome:{entries:[],notModified:true,etag:"fixture"},accepted:[],identityNamespaces:[],maintain:false});
  expect(db.getSource(source.id)?.etag).toBe("fixture");
  await db.write("deleteSource",source.id);
  await expect(db.write("commitSync",{source,subscription,outcome:{entries:[]},accepted:[entry],identityNamespaces:[],maintain:false})).rejects.toThrow("取消");
  expect(db.getEntry(entry.id)).toBeUndefined();
 }finally{clearTimeout(timer);if(raw.inTransaction)raw.exec("ROLLBACK");await worker.close();db.close();}
});

it("preserves fixed queue-full business errors while keeping storage errors private",async()=>{
 const file=path.join(directory,"domain-errors.sqlite"),db=new ReadingDatabase(file),worker=new StorageWorkerClient(file,workerFile);
 try{
  const source=db.createSource({url:"https://example.com/queue",title:"Queue",kind:"rss",pollingEnabled:true});
  db.saveEntries(Array.from({length:21},(_,i)=>({id:`q${i}`,sourceId:source.id,url:`https://example.com/queue/${i}`,canonicalUrl:`https://example.com/queue/${i}`,title:"Fixture",contentHash:"hash",createdAt:i,read:false,favorite:false})));
  for(let i=0;i<20;i++)await worker.rewrite("enqueue",`q${i}`,{provider:"deepseek",model:"fixture",effort:"default"});
  await expect(worker.rewrite("enqueue","q20",{provider:"deepseek",model:"fixture",effort:"default"})).rejects.toThrow("改写队列已满，请等待部分文章完成后再试。");
 }finally{await worker.close();db.close();}
});
it("coalesces a repeated confirmation while the semantic storage operation is pending",async()=>{
 const {SourceService}=await import("../src/main/source-service"),{SyncManager}=await import("../src/main/sync-manager"),{ConnectorRegistry}=await import("../src/main/connector-registry"),{contentNormalizer}=await import("../src/main/content-normalizer");
 const file=path.join(directory,"confirm.sqlite"),db=new ReadingDatabase(file),worker=new StorageWorkerClient(file,workerFile);db.setWriter(worker);
 const registry=new ConnectorRegistry();registry.register({manifest:{id:"manual",version:1,builtIn:true,displayName:"Manual"},sync:async()=>({entries:[]}),normalize:(entry,source)=>contentNormalizer.normalize(entry,source)});
 const sync=new SyncManager(db,registry),service=new SourceService(db,{probe:async()=>({url:"https://example.com/confirm",title:"Fixture",kind:"manual",confidence:1,requiresReview:false,preview:[{url:"https://example.com/article",title:"Article"}]})} as any,sync,{} as any);
 try{
  const {token}=await service.preview("https://example.com/confirm"),first=service.confirm(token),second=service.confirm(token);
  expect(first).toBe(second);expect((await first).id).toBe((await second).id);expect(db.listSources()).toHaveLength(1);expect(db.listEntries()).toHaveLength(1);
 }finally{await sync.close();await worker.close();db.close();}
});

it("keeps cards, supplied body, collection state and checkpoint in one worker transaction on failure",async()=>{
 const file=path.join(directory,"atomic-sync.sqlite"),db=new ReadingDatabase(file),worker=new StorageWorkerClient(file,workerFile);
 const source=db.createSource({url:"https://example.com/atomic",title:"Feed",kind:"rss",pollingEnabled:true}),subscription=db.getSubscriptionForSource(source.id)!;
 const entry={id:"atomic",sourceId:source.id,url:"https://example.com/atomic/post",canonicalUrl:"https://example.com/atomic/post",title:"Fixture",contentHash:"h",read:false,favorite:false,createdAt:1};
 const invalid={entryId:entry.id,url:entry.url,title:entry.title,renderProfile:"standard" as const,contentMode:"feed_body" as const,contentHtml:"",document:{version:999}} as any;
 try{
  await expect(worker.database("commitSync",{source,subscription,outcome:{entries:[{url:entry.url,title:entry.title}],etag:"must-not-commit",checkpoint:{cursor:"must-not-commit"}},accepted:[entry],identityNamespaces:[],bodies:[[entry.url,invalid]],maintain:false})).rejects.toThrow("正文结构无效");
  expect(db.getEntry(entry.id)).toBeUndefined();expect(db.getSource(source.id)?.etag).toBeUndefined();expect(db.getCheckpoint(subscription.id)).toBeUndefined();expect(db.getCollectionKind(source.id)).toBe("initial");
 }finally{await worker.close();db.close();}
});
it("drains accepted rewrite progress/checkpoints on close and restores them without recreating cancelled jobs",async()=>{
 const file=path.join(directory,"checkpoints.sqlite"),db=new ReadingDatabase(file),worker=new StorageWorkerClient(file,workerFile),settings={provider:"deepseek" as const,model:"fixture",effort:"default"};
 const source=db.createSource({url:"https://example.com/checkpoint",title:"Feed",kind:"rss",pollingEnabled:true});
 const entry={id:"checkpoint",sourceId:source.id,url:"https://example.com/checkpoint/post",canonicalUrl:"https://example.com/checkpoint/post",title:"Fixture",contentHash:"h",read:false,favorite:false,createdAt:1};db.saveEntries([entry]);
 try{
  const job=await worker.rewrite("enqueue",entry.id,settings);
  const progress=worker.rewrite("progress",job,1,2,"write"),save=worker.rewrite("saveStructuredCheckpoint",job,"key",{version:1,patches:[{paragraph:"已完成中文"}]}),closed=worker.close();
  await Promise.all([progress,save,closed]);
  const restarted=new StorageWorkerClient(file,workerFile);
  try{expect(await restarted.rewrite("structuredCheckpoint",job,"key")).toEqual({version:1,patches:[{paragraph:"已完成中文"}]});await restarted.rewrite("cancel",entry.id);await restarted.rewrite("saveStructuredCheckpoint",job,"key",{version:1,patches:[{paragraph:"迟到结果"}]});expect(await restarted.rewrite("structuredCheckpoint",job,"key")).toEqual({version:1,patches:[{paragraph:"已完成中文"}]});}
  finally{await restarted.close();}
 }finally{await worker.close();db.close();}
});
