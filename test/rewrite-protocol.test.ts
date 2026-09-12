import {expect,it,vi} from "vitest";
import {protectRewriteSection,restoreRewriteBlocks,RewriteProtocolError,rewriteSectionEnd} from "../src/main/rewrite-assets";
import {runRewritePipeline} from "../src/main/rewrite-pipeline";
const source=[{id:"B1",text:"## Delivery lifecycle"},{id:"B2",text:"- Plan\n- Build\n  - Test\n\nReview [the guide](https://example.com/guide)."},{id:"B3",text:"```ts\nconst literal = '$x$';\n```"}];
const materials=()=>protectRewriteSection(source);
const response=(blocks=materials())=>blocks.map(b=>`${b.open}\n${b.material.text}\n${b.close}`).join("\n\n");
it.each([['```markdown','```'],['```md','```'],['```','```'],['~~~markdown','~~~'],['````markdown','````']])("accepts a whole-response %s envelope without another model call",(open,close)=>{
 const blocks=materials();expect(restoreRewriteBlocks(`${open}\n${response(blocks)}\n${close}`,blocks)).toEqual(restoreRewriteBlocks(response(blocks),blocks));
});
it("avoids marker collisions with literal authored text",()=>{
 const blocks=protectRewriteSection([{id:"B1",text:"Literal ⟦B1⟧ and ⟦/B1⟧ belong to the explanation."}]);
 expect(blocks[0].open).not.toBe("⟦B1⟧");expect(restoreRewriteBlocks(response(blocks),blocks)[0]).toContain("Literal ⟦B1⟧");
});
it.each(["missing-open","missing-close","duplicate-marker","block-order","outside-text","empty-block","block-shape","asset-marker"])("reports %s without exposing model prose",code=>{
 const blocks=materials();let answer=response(blocks);
 if(code==="missing-open")answer=answer.replace(blocks[0].open,"");
 if(code==="missing-close")answer=answer.replace(blocks[0].close,"");
 if(code==="duplicate-marker")answer=answer.replace(blocks[0].open,blocks[0].open+blocks[0].open);
 if(code==="block-order")answer=response([blocks[1],blocks[0],blocks[2]]);
 if(code==="outside-text")answer="PRIVATE_MODEL_PROSE\n"+answer;
 if(code==="empty-block")answer=answer.replace(blocks[0].material.text,"");
 if(code==="block-shape")answer=answer.replace("## Delivery","Delivery");
 if(code==="asset-marker")answer=answer.replace(`⟦${blocks[2].material.atoms[0].id}⟧`,"​");
 try{restoreRewriteBlocks(answer,blocks);throw Error('unexpected acceptance');}catch(error){expect(error).toBeInstanceOf(RewriteProtocolError);expect((error as RewriteProtocolError).code).toBe(code);expect((error as Error).message).not.toContain("PRIVATE_MODEL_PROSE");}
});
it.each(["```markdown\nANSWER","ANSWER\n```","Intro\n```markdown\nANSWER\n```"])("does not discard ambiguous wrappers: %s",wrapper=>{
 const blocks=materials();expect(()=>restoreRewriteBlocks(wrapper.replace("ANSWER",response(blocks)),blocks)).toThrow();
});
it("keeps source tables, code and formula assets inside one safe envelope",async()=>{
 const text="## Plan\n\n| Stage | Goal |\n| --- | --- |\n| Build | $x_1$ |\n\n```js\nlet count = 1;\n```\n\n![chart](https://example.com/chart.png)";
 const run=vi.fn(async(_stage,prompt)=>{
  const p=JSON.parse(prompt);expect(p.instruction).not.toContain("不输出内部 ID");
  return "```markdown\n"+p.section.blocks.map((b:any)=>b.text).join("\n\n")+"\n"+p.endMarker+"\n```";
 });
 const result=await runRewritePipeline(text,"Fixture",run,new AbortController().signal);
 expect(run).toHaveBeenCalledTimes(1);expect(result.markdown).toContain("let count = 1;");expect(result.markdown).toContain("$x_1$");expect(result.markdown).not.toContain("⟦B");
});
it("includes failed section and category, retains prior checkpoint, never saves the failed response",async()=>{
 const text="First section ".repeat(450)+"\n\nSecond section ".repeat(400);let calls=0;const save=vi.fn();
 await expect(runRewritePipeline(text,"Fixture",async(_stage,prompt)=>{
  const blocks=JSON.parse(prompt).section.blocks;calls++;return calls===1?blocks.map((b:any)=>b.text).join("\n\n")+"\n"+JSON.parse(prompt).endMarker:"missing all markers";
 },new AbortController().signal,undefined,{save})).rejects.toThrow(/第 2\/.*missing-end/);
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0]).toHaveLength(1);
});

it("uses unambiguous one-way boundaries with a single section terminator",()=>{
 const blocks=materials();const text=blocks.map(b=>b.open+"\n"+b.material.text).join("\n\n")+"\n"+rewriteSectionEnd(blocks);
 expect(restoreRewriteBlocks(text,blocks)).toEqual(restoreRewriteBlocks(response(blocks),blocks));
 for(const malformed of [text.replace(rewriteSectionEnd(blocks),""),text.replace(blocks[1].open,""),text.replace(blocks[1].open,blocks[1].open+blocks[1].open),text+"Explanation"])
   expect(()=>restoreRewriteBlocks(malformed,blocks)).toThrow();
 expect(restoreRewriteBlocks("```markdown\n"+text+"\n```",blocks)).toEqual(restoreRewriteBlocks(text,blocks));
});
