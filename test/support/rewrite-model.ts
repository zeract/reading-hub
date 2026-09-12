import type {RewriteRequestStage} from "../../src/shared/rewrite";
export function rewriteModelResponse(prompt:string,stage:RewriteRequestStage="write"):string {
 const input=JSON.parse(prompt);
 if(stage==="review")return JSON.stringify({coverage:input.section.blocks.map((b:any)=>({blockId:b.id,covered:true})),issues:[]});
 return JSON.stringify({blocks:input.section.blocks});
}
