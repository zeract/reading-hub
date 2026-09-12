// Explicit maintenance: prepare a source-grounded repair in a snapshot; never overwrite the live draft.
import {app} from "electron";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import {createReadSnapshot} from "../dist/main/main/persistence/read-snapshot.js";
import {ReadingDatabase} from "../dist/main/main/database.js";
import {ArticleReader} from "../dist/main/main/article-reader.js";
import {PublicHttpClient} from "../dist/main/main/http.js";
import {IsolatedPageRenderer} from "../dist/main/main/page-renderer.js";
import {RobotsPolicy} from "../dist/main/main/robots.js";
import {AiService} from "../dist/main/main/ai-service.js";
import {SecretStore} from "../dist/main/main/secrets.js";
import {configureChromiumNetwork} from "../dist/main/main/network.js";
import {rewriteText,rewriteImageAliases} from "../dist/main/main/rewrite-content.js";
import {rewriteCards} from "../dist/main/main/rewrite-cards.js";
import {repairRewriteCardSections} from "../dist/main/main/rewrite-card-repair.js";
import {repairLegacyRewrite} from "../dist/main/main/rewrite-legacy-repair.js";
const dbPath=process.env.READING_HUB_REPAIR_DATABASE || path.join(app.getPath("appData"),"reading-hub","reading-hub.sqlite");
const report=process.env.READING_HUB_REPAIR_REPORT;if(!report || !process.env.READING_HUB_REPAIR_ENTRY)throw Error("Set READING_HUB_REPAIR_ENTRY and READING_HUB_REPAIR_REPORT to prepare a repair.");
const directory=await mkdtemp(path.join(tmpdir(),"reading-hub-repair-"));app.setPath("userData",directory);
let db,snapshot,ai;try {
 await app.whenReady();console.log("Reading source snapshot");await configureChromiumNetwork();snapshot=await createReadSnapshot(dbPath);db=new ReadingDatabase(snapshot.path);
 const entry=db.getEntry(process.env.READING_HUB_REPAIR_ENTRY);if(!entry)throw Error("Article unavailable");
 const saved=db.rewrites.get(entry.id);if(!saved?.result || ['running','queued'].includes(saved.status))throw Error("Saved rewrite is missing or busy");
 const localOnly=process.env.READING_HUB_REPAIR_CARDS_ONLY==='1';
 const settings=db.rewrites.settings();if(!localOnly && !settings)throw Error("Configure a rewrite model first");
 const robots=new RobotsPolicy();const reader=new ArticleReader(new PublicHttpClient(robots),new IsolatedPageRenderer(robots));
 const article=await reader.read(entry,db.getSource(entry.sourceId),{signal:AbortSignal.timeout(90000)});
 console.log("Source loaded; preparing source-aligned repair");
 let calls=0;
 const sourceText=rewriteText(article);
 const cards=repairRewriteCardSections(saved.result.sections || [saved.result.markdown],rewriteCards(article.contentHtml));
 if(!localOnly)ai=new AiService(new SecretStore());
 const result=localOnly ? {sections:cards.sections,markdown:cards.markdown,report:{cards:cards.repairs}} : await repairLegacyRewrite(sourceText,cards.sections,async(stage,prompt,signal)=>{
  if(process.env.READING_HUB_REPAIR_DRY_RUN==='1')return '[]';
  const key=createHash('sha256').update(JSON.stringify(settings)+prompt).digest('hex');const cache=report+'.'+key+'.cache';
  try{return await readFile(cache,'utf8');}catch{/* No cached response. */}
  console.log('Repair batch',++calls);
  const answer=(await ai.rewriteChunk(settings,prompt,signal,stage)).text;
  await writeFile(cache,answer,{mode:0o600});return answer;
 },AbortSignal.timeout(1_200_000),rewriteImageAliases(article));
 await writeFile(report,JSON.stringify({entryId:entry.id,oldResult:saved.result,result:{...saved.result,markdown:result.markdown,sections:result.sections,...(localOnly?{cardRepair:{version:1,repairedAt:Date.now(),sourceHash:createHash("sha256").update(sourceText).digest("hex"),groups:cards.repairs.length}}:{structureRepair:{version:1,provider:settings.provider,model:settings.model,repairedAt:Date.now(),sourceHash:createHash("sha256").update(sourceText).digest("hex")}})},settings,report:result.report}),{mode:0o600});
 console.log(JSON.stringify(result.report));
}catch(error){console.error(error instanceof Error?error.message:'Repair failed');process.exitCode=1;}
finally{await ai?.close();db?.close();await snapshot?.dispose();await rm(directory,{recursive:true,force:true});app.exit(process.exitCode||0);}
