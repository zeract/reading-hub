import {expect,it,vi} from "vitest";
import {protectRewriteSection,restoreRewriteBlocks,RewriteProtocolError,rewriteModelText} from "../src/main/rewrite-assets";
import {runRewritePipeline} from "../src/main/rewrite-pipeline";
const source=[{id:"B1",text:"## Delivery lifecycle"},{id:"B2",text:"- Plan\n- Build\n  - Test\n\nReview [the guide](https://example.com/guide)."},{id:"B3",text:"```ts\nconst literal = '$x$';\n```"}];
const materials=()=>protectRewriteSection(source);
const response=(blocks=materials())=>JSON.stringify({blocks:blocks.map(b=>({id:b.id,text:rewriteModelText(b.material)}))});
it.each([['```json','```'],['```','```'],['~~~json','~~~'],['````json','````']])("accepts a complete %s JSON envelope",(open,close)=>{
 const blocks=materials();expect(restoreRewriteBlocks(`${open}\n${response(blocks)}\n${close}`,blocks)).toEqual(restoreRewriteBlocks(response(blocks),blocks));
});
it("treats authored block markers as prose, and restores source order by ID",()=>{
 const blocks=protectRewriteSection([{id:"B1",text:"Literal ⟦B1⟧, ⟦/B1⟧ and ⟦END⟧."},{id:"B2",text:"Second."}]);
 expect(restoreRewriteBlocks(response([...blocks].reverse()),blocks)).toEqual(blocks.map(b=>b.material.text));
});
it.each(["response-format","missing-block","duplicate-block","unknown-block","empty-block","block-shape","asset-marker"])("reports %s without exposing model prose",code=>{
 const blocks=materials();const value=JSON.parse(response(blocks));
 if(code==="missing-block")value.blocks.shift();
 if(code==="duplicate-block")value.blocks.push(value.blocks[0]);
 if(code==="unknown-block")value.blocks.push({id:"PRIVATE_MODEL_PROSE",text:"private"});
 if(code==="empty-block")value.blocks[0].text=" ";
 if(code==="block-shape")value.blocks[0].text="Delivery";
 if(code==="asset-marker")value.blocks[2].text="missing";
 const answer=code==="response-format" ? 'PRIVATE_MODEL_PROSE\n'+JSON.stringify(value) : JSON.stringify(value);
 try{restoreRewriteBlocks(answer,blocks);throw Error('unexpected acceptance');}catch(error){expect(error).toBeInstanceOf(RewriteProtocolError);expect((error as RewriteProtocolError).code).toBe(code);expect((error as Error).message).not.toContain("PRIVATE_MODEL_PROSE");}
});
it.each(['{"blocks":', '{"blocks":[],"explanation":"extra"}', '{"blocks":[null]}', '{"blocks":[{"id":"B1","text":1}]}', '{"blocks":[{"id":"B1","text":"x","extra":true}]}', '[]'])("rejects truncated/wrong/extra fields: %s",answer=>{
 expect(()=>restoreRewriteBlocks(answer,materials())).toThrow();
});
it("keeps source tables, code and formula assets in one model call",async()=>{
 const text="## Plan\n\n| Stage | Goal |\n| --- | --- |\n| Build | $x_1$ |\n\n```js\nlet count = 1;\n```\n\n![chart](https://example.com/chart.png)";
 const run=vi.fn(async(_stage,prompt)=>JSON.stringify({blocks:JSON.parse(prompt).section.blocks}));
 const result=await runRewritePipeline(text,"Fixture",run,new AbortController().signal);
 expect(run).toHaveBeenCalledTimes(1);expect(result.markdown).toContain("let count = 1;");expect(result.markdown).toContain("$x_1$");expect(result.markdown).not.toContain("⟦B");
});
it("retains prior checkpoint and never saves a failed response",async()=>{
 const text="First section ".repeat(450)+"\n\nSecond section ".repeat(400);let calls=0;const save=vi.fn();
 await expect(runRewritePipeline(text,"Fixture",async(_stage,prompt)=>{
  calls++;return calls===1?JSON.stringify({blocks:JSON.parse(prompt).section.blocks}):"invalid response";
 },new AbortController().signal,undefined,{save})).rejects.toThrow(/第 2\/.*response-format/);
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0]).toHaveLength(1);
});
