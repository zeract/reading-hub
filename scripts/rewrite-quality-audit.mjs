import {app} from "electron";
import {writeFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {AiService} from "../dist/main/main/ai-service.js";
import {SecretStore} from "../dist/main/main/secrets.js";
import {configureChromiumNetwork} from "../dist/main/main/network.js";
import {runRewritePipeline} from "../dist/main/main/rewrite-pipeline.js";
import {splitRewriteText} from "../dist/main/main/rewrite-content.js";
import {rewriteQualityCases} from "./fixtures/rewrite-quality.mjs";
const directory=await mkdtemp(path.join(tmpdir(),"reading-hub-rewrite-eval-"));app.setPath("userData",directory);
const reportPath=process.env.READING_HUB_REWRITE_REPORT || path.join(tmpdir(),"reading-hub-rewrite-quality.json");
let ai;const report=[];let failed=false;
try {
 await app.whenReady();await configureChromiumNetwork();ai=new AiService(new SecretStore());
 const providers=await ai.listProviders();const provider=providers.find(p=>p.id===(process.env.READING_HUB_REWRITE_PROVIDER||"deepseek")&&p.configured);
 if(!provider)throw new Error("评估所选服务未配置。");
 const settings={provider:provider.id,model:process.env.READING_HUB_REWRITE_MODEL||provider.model,effort:provider.effort||"default"};
 const signal=AbortSignal.timeout(1_200_000);
 const samples=rewriteQualityCases.filter(s=>!process.env.READING_HUB_REWRITE_CASE||s.id===process.env.READING_HUB_REWRITE_CASE);
 if(!samples.length)throw new Error("未找到指定评估样本。");
 for(const sample of samples) {
  const row={id:sample.id,settings};report.push(row);
  for(const mode of ["baseline","reviewed"]) {
   console.log(`${sample.id}: ${mode}`);const start=Date.now();let calls=0;const trace=[];
   try {
    let result;
    if(mode==="baseline") {const parts=[];for(const chunk of splitRewriteText(sample.text)){calls++;parts.push((await ai.rewriteChunk(settings,`标题：${sample.title}\n请完整中文改写以下片段：\n${chunk}`,signal)).text);}result={markdown:parts.join("\n\n")};}
    else result=await runRewritePipeline(sample.text,sample.title,async(stage,prompt,s)=>{calls++;console.log(`${sample.id}: ${stage} ${calls}`);const answer=(await ai.rewriteChunk(settings,prompt,s,stage)).text;trace.push({stage,answer});return answer;},signal);
    row[mode]={...result,trace,calls,elapsedMs:Date.now()-start,missingAnchors:sample.anchors.filter(a=>!result.markdown.includes(a))};
    if(row[mode].missingAnchors.length)failed=true;
   }catch(error){failed=true;row[mode]={trace,calls,elapsedMs:Date.now()-start,error:error instanceof Error?error.message:"评估失败"};}
   await writeFile(reportPath,JSON.stringify(report,null,2));
  }
 }
 console.log(JSON.stringify(report.map(r=>({id:r.id,baseline:{calls:r.baseline?.calls,ms:r.baseline?.elapsedMs,missing:r.baseline?.missingAnchors,error:r.baseline?.error},reviewed:{calls:r.reviewed?.calls,ms:r.reviewed?.elapsedMs,missing:r.reviewed?.missingAnchors,quality:r.reviewed?.quality,error:r.reviewed?.error}}))));
 console.log(`Report: ${reportPath}`);
}catch(error){failed=true;console.error(error instanceof Error?error.message:"评估失败");}
finally{await ai?.close();await rm(directory,{recursive:true,force:true});app.exit(failed?1:0);}
