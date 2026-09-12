import type {RewriteStage} from "../../src/shared/rewrite";
export function rewriteModelResponse(prompt:string,stage:RewriteStage="write"):string {
 const input=JSON.parse(prompt);
 if(stage==="plan")return JSON.stringify({summary:"本节介绍事实与适用条件。",terms:[]});
 if(stage==="outline")return JSON.stringify({sections:input.sections,terms:[]});
 if(stage==="review")return JSON.stringify({coverage:input.section.blocks.map((b:any)=>({blockId:b.id,covered:true})),issues:[]});
 return "## 中文正文\n\n严谨改写的正文。";
}
