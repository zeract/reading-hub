import {expect,it,vi} from "vitest";
import {makeRewriteSections,parseReview,runRewritePipeline} from "../src/main/rewrite-pipeline";
import {rewriteModelResponse} from "./support/rewrite-model";
const source="The cache reduced latency from 100 ms to 80 ms in one test. This does not establish a universal result.";
it("requires every original block in review and rejects invented evidence",()=>{
 const section=makeRewriteSections(source+"\n\nSecond paragraph.")[0];
 expect(()=>parseReview(JSON.stringify({coverage:[{blockId:"B1",covered:true}],issues:[]}),section)).toThrow("格式不完整");
 expect(()=>parseReview(JSON.stringify({coverage:section.blocks.map(b=>({blockId:b.id,covered:true})),issues:[{blockId:"B1",kind:"meaning",message:"Wrong.",sourceQuote:"invented quotation"}]}),section)).toThrow("格式不完整");
 expect(()=>parseReview(JSON.stringify({coverage:section.blocks.map(b=>({blockId:b.id,covered:false})),issues:[]}),section)).toThrow("具体漏项");
});
it("shares a global glossary, carries neighbouring context and repairs only the flagged section before rechecking",async()=>{
 const inputs:any[]=[];let reviewCount=0;
 const runner=vi.fn(async(stage,prompt)=>{
  const input=JSON.parse(prompt);inputs.push({stage,...input});
  if(stage==="plan")return JSON.stringify({summary:"缓存实验的范围限制。",terms:[{source:"cache",target:"缓存"}]});
  if(stage==="outline")return JSON.stringify({sections:input.sections,terms:[{source:"cache",target:"缓存"}]});
  if(stage==="review" && reviewCount++===0)return JSON.stringify({coverage:input.section.blocks.map(b=>({blockId:b.id,covered:true})),issues:[{blockId:input.section.blocks[0].id,kind:"meaning",message:"保留限制条件。",sourceQuote:"does not establish a universal result"}]});
  return rewriteModelResponse(prompt,stage);
 });
 const result=await runRewritePipeline(Array.from({length:70},()=>source).join("\n\n"),"Fixture",runner,new AbortController().signal);
 expect(result.quality.repairedSections).toBe(1);expect(result.quality.reviewedBlocks).toBe(70);
 expect(inputs.filter(i=>i.stage==="write").every(i=>i.outline.terms[0].target==="缓存")).toBe(true);
 expect(inputs.filter(i=>i.stage==="write")[1].previousEnding).toContain("严谨改写");
 expect(inputs.filter(i=>i.stage==="review").every(i=>i.nextOpening===undefined)).toBe(true);
 expect(inputs.find(i=>i.stage==="review" && i.section.id==="S2").previousEnding).toContain("严谨改写");
 expect(inputs.filter(i=>i.stage==="revise")).toHaveLength(1);expect(result.quality.requests).toBe(runner.mock.calls.length);
});
it("never treats unresolved review issues or malformed plans as a completed rewrite",async()=>{
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);
  if(stage==="review")return JSON.stringify({coverage:input.section.blocks.map(b=>({blockId:b.id,covered:false})),issues:input.section.blocks.map(b=>({blockId:b.id,kind:"omission",message:"缺少原文事实。",sourceQuote:b.text}))});
  return rewriteModelResponse(prompt,stage);
 };
 await expect(runRewritePipeline(source,"Fixture",runner,new AbortController().signal)).rejects.toThrow("修订后仍有");
 await expect(runRewritePipeline(source,"Fixture",async()=>"Looks good",new AbortController().signal)).rejects.toThrow("格式不完整");
});
it("cancels between stages without launching a second model request",async()=>{
 const controller=new AbortController();const run=vi.fn(async(stage,prompt)=>{controller.abort();return rewriteModelResponse(prompt,stage);});
 await expect(runRewritePipeline(source,"Fixture",run,controller.signal)).rejects.toThrow();expect(run).toHaveBeenCalledTimes(1);
});
it("keeps each paragraph and code block in exactly one identified section",()=>{
 const text=Array.from({length:30},(_,i)=>`Paragraph ${i}: `+"Evidence remains bounded. ".repeat(20).trim()).join("\n\n")+"\n\n```\na=1\n\nb=2\n```";
 const sections=makeRewriteSections(text);const blocks=sections.flatMap(s=>s.blocks);
 expect(new Set(blocks.map(b=>b.id)).size).toBe(blocks.length);expect(blocks.map(b=>b.text).join("\n\n")).toBe(text);
});
it("rechecks an invalid evidence mapping once, without accepting unverified coverage",async()=>{
 let reviews=0;const inputs:any[]=[];
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);inputs.push({stage,...input});
  if(stage==="review" && reviews++===0)return JSON.stringify({coverage:[{blockId:"B1",covered:true}],issues:[{blockId:"B1",kind:"meaning",message:"Verify.",sourceQuote:"invented"}]});
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline(source,"Fixture",runner,new AbortController().signal);
 expect(result.quality.requests).toBe(5);
 expect(inputs.filter(i=>i.stage==="review")[1].validationFeedback).toContain("B1");
 expect(result.quality.repairedSections).toBe(0);
 const broken=vi.fn(async(stage,prompt)=>stage==="review"?"invalid":rewriteModelResponse(prompt,stage));
 await expect(runRewritePipeline(source,"Fixture",broken,new AbortController().signal)).rejects.toThrow("格式不完整");
 expect(broken).toHaveBeenCalledTimes(5);
});
it("canonicalizes term casing to real source spelling without accepting invented terms",async()=>{
 const runner=async(stage,prompt)=>{
  if(stage==="plan")return JSON.stringify({summary:"延迟实验。",terms:[{source:"median latency",target:"延迟中位数"}]});
  const input=JSON.parse(prompt);
  if(stage==="outline")return JSON.stringify({sections:input.sections,terms:[{source:"MEDIAN LATENCY",target:"延迟中位数"}]});
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline("Median latency fell to 80 ms.","Fixture",runner,new AbortController().signal);
 expect(result.quality.terms).toEqual([{source:"Median latency",target:"延迟中位数"}]);
 const withoutTerms = await runRewritePipeline("A different experiment.","Fixture",runner,new AbortController().signal);
 expect(withoutTerms.quality.terms).toEqual([]);
});
it.each(["plan","outline"])("retries invalid %s output with field feedback and stops after one retry",async(badStage)=>{
 const inputs:any[]=[];let invalid=0;
 const runner=vi.fn(async(stage,prompt)=>{
  const input=JSON.parse(prompt);inputs.push({stage,...input});
  if(stage===badStage && invalid++===0) return badStage==="plan"?JSON.stringify({summary:"超".repeat(601),terms:[]}):JSON.stringify({sections:[],terms:[]});
  return rewriteModelResponse(prompt,stage);
 });
 const result=await runRewritePipeline(source,"Fixture",runner,new AbortController().signal);
 expect(result.quality.requests).toBe(5);
 expect(inputs.filter(i=>i.stage===badStage)[1].validationFeedback).toContain(badStage==="plan"?"summary":"sections");
 const broken=vi.fn(async(stage,prompt)=>stage===badStage?"private invalid output":rewriteModelResponse(prompt,stage));
 const error=await runRewritePipeline(source,"Fixture",broken,new AbortController().signal).catch(e=>e);
 expect(error.message).toContain(badStage==="plan"?"第 1 节“梳理原文”":"全文“统一提纲与术语”");
 expect(error.message).toContain("已自动重试一次");expect(error.message).not.toContain("private");
 expect(broken.mock.calls.filter(c=>c[0]===badStage)).toHaveLength(2);
});
it("normalizes fenced JSON, duplicate identical terms and source whitespace without losing evidence",async()=>{
 const text="Median\nlatency was 80 ms. The cost was -10.";
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);
  if(stage==="plan")return '```json '+JSON.stringify({summary:"中".repeat(350),terms:[{source:"median latency",target:"延迟"},{source:"MEDIAN LATENCY",target:"延迟"}]})+'```';
  if(stage==="outline")return JSON.stringify({sections:input.sections,terms:input.candidates});
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline(text,"Fixture",runner,new AbortController().signal);
 expect(result.quality.terms).toEqual([{source:"Median\nlatency",target:"延迟"}]);
 const section=makeRewriteSections(text)[0];
 const response=(quote:string)=>JSON.stringify({coverage:[{blockId:"B1",covered:true}],issues:[{blockId:"B1",kind:"meaning",message:"检查。",sourceQuote:quote}]});
 expect(parseReview(response("Median latency was 80 ms."),section)[0].sourceQuote).toBe("Median\nlatency was 80 ms.");
 expect(()=>parseReview(response("The cost was 10."),section)).toThrow("不属于");
});
it("does not retry transport errors or launch a repair after cancellation",async()=>{
 const failed=vi.fn(async()=>{throw new Error("network failure");});
 await expect(runRewritePipeline(source,"Fixture",failed,new AbortController().signal)).rejects.toThrow("network failure");
 expect(failed).toHaveBeenCalledTimes(1);
 const c=new AbortController();const runner=vi.fn(async()=>{c.abort();return "invalid";});
 await expect(runRewritePipeline(source,"Fixture",runner,c.signal)).rejects.toThrow();expect(runner).toHaveBeenCalledTimes(1);
});
it("recovers first-plan failure in a 28-section job without skipping later sections",async()=>{
 const text=Array.from({length:28},(_,i)=>`Section ${i+1}. `+"Each observation has a limited scope. ".repeat(100).trim()).join("\n\n");
 const writes:string[]=[];let first=true;
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);
  if(stage==="plan") {
   if(first){first=false;return "invalid";}
   return JSON.stringify({summary:input.section.id==="S1"?"中".repeat(350):"本节限定条件。",terms:input.section.id==="S7"?[{source:"unsupported glossary term",target:"无来源词条"}]:[]});
  }
  if(stage==="write")writes.push(input.section.id);
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline(text,"Fixture",runner,new AbortController().signal);
 expect(writes).toEqual(Array.from({length:28},(_,i)=>`S${i+1}`));
 expect(result.quality).toMatchObject({reviewedSections:28,reviewedBlocks:28,requests:86});
});
it("drops unsupported advisory terms in both planning stages while retaining grounded terms",async()=>{
 const materials:any[]=[];
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);materials.push({stage,...input});
  if(stage==="plan")return JSON.stringify({summary:"缓存的适用条件。",terms:[
   {source:"caches",target:"缓存"},{source:"cache",target:"缓存"},{source:"invented",target:"编造"},
   {source:"latency",target:"延迟"},{source:"latency",target:"时延"},null,{source:"wrong"}
  ]});
  if(stage==="outline")return JSON.stringify({sections:input.sections,terms:[...input.candidates,{source:"invented glossary",target:"错误候选"}]});
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline(source,"Fixture",runner,new AbortController().signal);
 expect(result.quality.terms).toEqual([{source:"cache",target:"缓存"}]);
 expect(result.quality.requests).toBe(4);
 expect(materials.find(m=>m.stage==="write").section.blocks[0].text).toBe(source);
});
it("allows an absent advisory glossary but never absent source coverage",async()=>{
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);
  if(stage==="plan")return JSON.stringify({summary:"完整提纲。"});
  if(stage==="outline")return JSON.stringify({sections:input.sections,terms:null});
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline(source,"Fixture",runner,new AbortController().signal);
 expect(result.quality.terms).toEqual([]);expect(result.quality.reviewedBlocks).toBe(1);
 expect(()=>parseReview('{"issues":[]}',makeRewriteSections(source)[0])).toThrow("coverage");
});
it("budgets advisory outlines for long articles without truncating any source block",async()=>{
 const text=Array.from({length:28},(_,i)=>`Section ${i+1}. `+"Every detail remains in the original source. ".repeat(90).trim()).join("\n\n");
 const writes:any[]=[];
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);
  if(stage==="plan")return JSON.stringify({summary:'详述"事实"与限定。'.repeat(55),terms:[]});
  if(stage==="outline")return JSON.stringify({sections:input.sections.map(s=>({...s,summary:'详述"事实"与限定。'.repeat(55)})),terms:[]});
  if(stage==="write")writes.push(input);
  return rewriteModelResponse(prompt,stage);
 };
 const result=await runRewritePipeline(text,"Fixture",runner,new AbortController().signal);
 expect(result.quality.requests).toBe(85);
 expect(JSON.stringify(writes[0].outline).length).toBeLessThanOrEqual(8500);
 expect(writes[0].outline.sections[0].summary).toContain("提纲节选");
 expect(writes.flatMap(w=>w.section.blocks.map(b=>b.text)).join("\n\n")).toBe(text);
});
