import {expect,it,vi} from "vitest";
import {makeRewriteSections,parseReview,runRewritePipeline} from "../src/main/rewrite-pipeline";
import {rewriteModelResponse} from "./support/rewrite-model";
const source="The cache reduced latency from 100 ms to 80 ms in one test. This does not establish a universal result.";
it("requires every original block in review and rejects invented evidence",()=>{
 const section=makeRewriteSections(source+"\n\nSecond paragraph.")[0];
 expect(()=>parseReview(JSON.stringify({coverage:[{blockId:"B1",covered:true}],issues:[]}),section)).toThrow("格式不完整");
 expect(()=>parseReview(JSON.stringify({coverage:section.blocks.map(b=>({blockId:b.id,covered:true})),issues:[{blockId:"B1",kind:"meaning",message:"Wrong.",sourceQuote:"invented quotation"}]}),section)).toThrow("格式不完整");
 expect(parseReview(JSON.stringify({coverage:section.blocks.map(b=>({blockId:b.id,covered:false})),issues:[]}),section)).toHaveLength(2);
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
 expect(inputs.find(i=>i.stage==="review").nextOpening).toContain("严谨改写");
 expect(inputs.filter(i=>i.stage==="revise")).toHaveLength(1);expect(result.quality.requests).toBe(runner.mock.calls.length);
});
it("never treats unresolved review issues or malformed plans as a completed rewrite",async()=>{
 const runner=async(stage,prompt)=>{
  const input=JSON.parse(prompt);
  if(stage==="review")return JSON.stringify({coverage:input.section.blocks.map(b=>({blockId:b.id,covered:false})),issues:[]});
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
 await expect(runRewritePipeline("A different experiment.","Fixture",runner,new AbortController().signal)).rejects.toThrow("格式不完整");
});
