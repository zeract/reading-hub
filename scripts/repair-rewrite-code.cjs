// Run with Electron. Defaults to a read-only snapshot; --apply requires exact
// source URL correspondence and compares the saved result before updating.
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'../dist/main/main');
(async()=>{let db,snapshot;try{
 await app.whenReady();
 const [databasePath,entryId,sourcePath,mode]=process.argv.slice(2);
 if(!databasePath||!entryId||!sourcePath)throw Error('Usage: electron scripts/repair-rewrite-code.cjs database entry-id source-json [--apply]');
 const source=JSON.parse(fs.readFileSync(sourcePath,'utf8'));
 snapshot=await require(path.join(base,'persistence/read-snapshot')).createReadSnapshot(databasePath);
 const {ReadingDatabase}=require(path.join(base,'database'));db=new ReadingDatabase(snapshot.path);
 const original=db.db.prepare('SELECT result_json,status FROM article_rewrites WHERE entry_id=?').get(entryId);
 if(!original?.result_json||['running','queued'].includes(original.status))throw Error('No idle saved rewrite');
 const {decodeRewriteResult,encodeRewriteResult}=require(path.join(base,'rewrite-document'));
 const saved=decodeRewriteResult(original.result_json);
 if(source.url!==saved.sourceUrl)throw Error('Source URL mismatch');
 const fixed=require(path.join(base,'rewrite-code-repair')).repairLegacyJsonCode(saved,source.document);
 const titleAdded=!saved.rewrittenTitle && source.title===saved.sourceTitle && typeof source.rewrittenTitle==='string' && Boolean(source.rewrittenTitle.trim());
 if(titleAdded)fixed.result={...fixed.result,rewrittenTitle:source.rewrittenTitle};
 const encoded=encodeRewriteResult(fixed.result);decodeRewriteResult(encoded);
 console.log(JSON.stringify({repaired:fixed.repaired,titleAdded,apply:mode==='--apply'}));
 db.close();db=undefined;
 if(mode==='--apply'&&(fixed.repaired||titleAdded)){
  db=new ReadingDatabase(databasePath);
  db.db.transaction(()=>{
   const current=db.db.prepare('SELECT result_json,status FROM article_rewrites WHERE entry_id=?').get(entryId);
   if(current?.result_json!==original.result_json||['running','queued'].includes(current.status))throw Error('Rewrite changed; no update applied');
   db.db.prepare('INSERT OR IGNORE INTO rewrite_migration_backups VALUES (?,?)').run(entryId,original.result_json);
   db.db.prepare('UPDATE article_rewrites SET result_json=? WHERE entry_id=?').run(encoded,entryId);
  })();
 }
 }catch(error){console.error(error.message);process.exitCode=1;}finally{db?.close();await snapshot?.dispose();app.exit(process.exitCode||0);}})();
