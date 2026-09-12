import type {RewriteRequestStage} from "../../src/shared/rewrite";
export function rewriteModelResponse(prompt:string,stage:RewriteRequestStage="write"):string {
 const input=JSON.parse(prompt);
 if(stage==="review")return JSON.stringify({coverage:input.section.blocks.map((b:any)=>({blockId:b.id,covered:true})),issues:[]});
 if(input.assets?.length || /⟦RH/.test(JSON.stringify(input.section))) return "## 中文正文\n\n"+input.section.blocks.map((b:any)=>b.text).join("\n\n");
 return "## 中文正文\n\n严谨改写的正文。";
}
