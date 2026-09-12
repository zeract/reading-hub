import type {RewriteRequestStage} from "../../src/shared/rewrite";
export function rewriteModelResponse(prompt:string,stage:RewriteRequestStage="write"):string {
 const input=JSON.parse(prompt);
 if(stage==="review")return JSON.stringify({coverage:input.section.blocks.map((b:any)=>({blockId:b.id,covered:true})),issues:[]});
 return "## 中文正文\n\n严谨改写的正文。";
}
