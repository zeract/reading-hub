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
