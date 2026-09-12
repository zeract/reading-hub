import {expect,it,vi} from "vitest";
import {makeRewriteSections,parseReview,runRewritePipeline,reviewRewrite} from "../src/main/rewrite-pipeline";
import {rewriteModelResponse} from "./support/rewrite-model";
const source="The cache reduces latency by 20% only when warm. Cold requests have no guarantee.";
const signal=()=>new AbortController().signal;
it("writes a short article once, without planning, review or repair",async()=>{
 const run=vi.fn(async(stage,prompt)=>rewriteModelResponse(prompt,stage));
 const result=await runRewritePipeline(source,"Fixture",run,signal());
 expect(run).toHaveBeenCalledTimes(1);expect(run.mock.calls[0][0]).toBe("write");
 expect(result.quality).toMatchObject({requests:1,reviewedSections:0});expect(result.sections.join("\n\n")).toBe(result.markdown);
});
it("uses 28 calls instead of 85 for 28 sections and preserves complete source",async()=>{
 const text=Array.from({length:28},(_,i)=>`Section ${i+1}. `+"Every detail remains in the original source. ".repeat(90).trim()).join("\n\n");
 const inputs:any[]=[];
 const result=await runRewritePipeline(text,"Fixture",async(stage,prompt)=>{const input=JSON.parse(prompt);inputs.push(input);return JSON.stringify({blocks:input.section.blocks.map(b=>({id:b.id,text:`中文术语（terminology）${inputs.length}`}))});},signal());
 expect(result.quality.requests).toBe(28);expect(inputs.flatMap(x=>x.section.blocks.map(b=>b.text)).join("\n\n")).toBe(text);
 expect(inputs[1].previousEnding).toBe(result.sections[0]);expect(inputs[2].opening).toBe(result.sections[0]);
});
it("keeps every paragraph and code block in exactly one section",()=>{
 const text=Array.from({length:30},(_,i)=>`Paragraph ${i}: `+"Evidence remains bounded. ".repeat(20).trim()).join("\n\n")+"\n\n```\na=1\n\nb=2\n```";
 const blocks=makeRewriteSections(text).flatMap(s=>s.blocks);
 expect(new Set(blocks.map(b=>b.id)).size).toBe(blocks.length);expect(blocks.map(b=>b.text).join("\n\n")).toBe(text);
});
it("checkpoints successful sections but not an aborted late response",async()=>{
 const controller=new AbortController();const save=vi.fn();
 await expect(runRewritePipeline(source,"Fixture",async()=>{controller.abort();return "late";},controller.signal,undefined,{save})).rejects.toThrow();
 expect(save).not.toHaveBeenCalled();
});
it("resumes all completed sections without requests, rejecting oversized saved output",async()=>{
 const run=vi.fn();const result=await runRewritePipeline(source,"Fixture",run,signal(),undefined,{drafts:["已完成"]});
 expect(run).not.toHaveBeenCalled();expect(result.markdown).toBe("已完成");
 await expect(runRewritePipeline(source,"Fixture",run,signal(),undefined,{drafts:["中".repeat(13001)]})).rejects.toThrow();
});
it.each(["","中".repeat(40000)])("does not checkpoint empty or oversized output",async(answer)=>{
 const save=vi.fn();await expect(runRewritePipeline(source,"Fixture",async()=>answer,signal(),undefined,{save})).rejects.toThrow();expect(save).not.toHaveBeenCalled();
});
it("optional review returns factual and cohesion issues without rewriting the saved draft",async()=>{
 const drafts=["中文稿"];
 const run=vi.fn(async()=>JSON.stringify({coverage:[{blockId:"B1",covered:false}],issues:[{blockId:"B1",kind:"number",message:"核对20%",sourceQuote:"20%"},{blockId:"B1",kind:"cohesion",message:"过渡",sourceQuote:""}]}));
 const review=await reviewRewrite(source,"Fixture",drafts,run,signal());
 expect(review.issues).toHaveLength(2);expect(run).toHaveBeenCalledTimes(1);expect(drafts).toEqual(["中文稿"]);expect(review.issues[0].sectionId).toBe("S1");
});
it("retries malformed optional review once, never pretending it completed",async()=>{
 const run=vi.fn().mockResolvedValue("invalid");
 await expect(reviewRewrite(source,"Fixture",["中文"],run,signal())).rejects.toThrow("已保存中文仍可阅读");expect(run).toHaveBeenCalledTimes(2);
});
it("requires real source evidence and explicit explanation for uncovered blocks",()=>{
 const section=makeRewriteSections(source)[0];
 expect(()=>parseReview('{"coverage":[{"blockId":"B1","covered":false}],"issues":[]}',section)).toThrow("未说明");
 expect(()=>parseReview(JSON.stringify({coverage:[{blockId:"B1",covered:true}],issues:[{blockId:"B1",kind:"meaning",message:"wrong",sourceQuote:"invented"}]}),section)).toThrow("引文");
 expect(parseReview(JSON.stringify({coverage:[{blockId:"B1",covered:true}],issues:[{blockId:"B1",kind:"meaning",message:"check",sourceQuote:"only when warm"}]}),section)[0].sourceQuote).toBe("only when warm");
});
it("rejects missing coverage, duplicated ids, and review/source section mismatch",async()=>{
 const section=makeRewriteSections(source)[0];
 expect(()=>parseReview('{"issues":[]}',section)).toThrow("coverage");
 expect(()=>parseReview('{"coverage":[{"blockId":"B1","covered":true},{"blockId":"B1","covered":true}],"issues":[]}',section)).toThrow("coverage");
 const run=vi.fn();await expect(reviewRewrite(source,"Fixture",[],run,signal())).rejects.toThrow("结构");expect(run).not.toHaveBeenCalled();
});
it("keeps immutable code, image and formula blocks out of model output while retaining their source positions",async()=>{
 const text='Before.\n\n```js\nlet x = 1;\n```\n\n![chart](<https://example.com/a.png>)\n\n$$\nx_1=1\n$$\n\nAfter.';
 const run=vi.fn(async(stage,prompt)=>{const p=JSON.parse(prompt);expect(p.section.blocks).toHaveLength(2);expect(p.assets).toHaveLength(3);return rewriteModelResponse(prompt,stage);});
 const r=await runRewritePipeline(text,'Fixture',run,signal());expect(r.markdown).toBe(text);expect(run).toHaveBeenCalledTimes(1);expect(r.document.blocks).toHaveLength(5);
 const empty=vi.fn();const fixed=await runRewritePipeline('```js\nlet x = 1;\n```','Fixture',empty,signal());expect(empty).not.toHaveBeenCalled();expect(fixed.quality.requests).toBe(0);
});

it("rejects copying a program-owned code block into another generated block",async()=>{
 const text='Prose.\n\n```js\nlet x = 1;\n```';
 await expect(runRewritePipeline(text,'Fixture',async(_stage,prompt)=>{
   const p=JSON.parse(prompt);return JSON.stringify({blocks:[{id:p.section.blocks[0].id,text:p.section.blocks[0].text+'\n\n```js\nlet x = 1;\n```'}]});
 },signal())).rejects.toThrow('literal/code/unknown');
});

it("does not checkpoint an immutable-only section when cancelled during progress",async()=>{
 const controller=new AbortController();const save=vi.fn(),run=vi.fn();
 await expect(runRewritePipeline('```js\nlet x = 1;\n```','Fixture',run,controller.signal,()=>controller.abort(),{save})).rejects.toThrow();
 expect(save).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
