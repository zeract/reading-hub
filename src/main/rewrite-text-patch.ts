import type {TextNode} from '../shared/article-document';
import {RewriteContentError} from './rewrite-content';
import {parseRewriteResponse} from './rewrite-response';

export type TextPatchReason='missing'|'duplicate'|'unknown-node'|'node-shape'|'text-type'|'text-length'|'response-shape';
export interface TextPatchIssue {paragraph:string;reference:'paragraph'|'unknown';reason:TextPatchReason}

/** Only source-owned IDs and fixed categories may cross the diagnostic boundary.
 * Invalid known nodes are removed entirely, including every duplicate candidate.
 * Unassignable records are never reused or mapped to a guessed source ID. */
export class TextPatchValidationError extends RewriteContentError {
 constructor(readonly patch:Record<string,string>,readonly issues:TextPatchIssue[],readonly scope:'paragraphs'|'section') {
  const first=issues[0];
  super(`改写文字节点 ${first.paragraph==='section'?'unknown':first.paragraph} 校验失败（${first.reason}），已完成分节仍保留。`);
 }
}

export function parseTextPatch(raw:string,nodes:readonly TextNode[],fromParts?:(id:string,parts:unknown)=>string):Record<string,string> {
 const value:unknown=parseRewriteResponse(raw);
 const sectionIssue=(reason:TextPatchReason):TextPatchIssue=>({paragraph:'section',reference:'unknown',reason});
 if(!value||typeof value!=='object'||!('blocks' in value)||!Array.isArray(value.blocks)||Object.keys(value).length!==1) {
  throw new TextPatchValidationError({},[sectionIssue('response-shape')],'section');
 }
 const expected=new Map(nodes.map(n=>[n.id,n]));
 const seen=new Set<string>(),invalid=new Map<string,TextPatchReason>();
 const result:Record<string,string>={},sectionIssues:TextPatchIssue[]=[];
 for(const block of value.blocks){
  if(!block||typeof block!=='object'||Array.isArray(block)||typeof block.id!=='string'){
   sectionIssues.push(sectionIssue('node-shape'));continue;
  }
  const source=expected.get(block.id);
  if(!source){sectionIssues.push(sectionIssue('unknown-node'));continue;}
  if(seen.has(source.id)){invalid.set(source.id,'duplicate');delete result[source.id];continue;}
  seen.add(source.id);
  // Only a known source block may enter the typed repair decoder. Legacy text
  // responses/checkpoints keep the exact same contract and limits.
  const text=fromParts&&Object.keys(block).length===2&&Object.hasOwn(block,'parts')
   ?fromParts(source.id,block.parts):block.text;
  const reason=Object.keys(block).length!==2?'node-shape':typeof text!=='string'?'text-type':text.length>Math.max(2000,source.text.length*6)?'text-length':undefined;
  if(reason)invalid.set(source.id,reason);else result[source.id]=text;
 }
 const issues:TextPatchIssue[]=[];
 for(const node of nodes){
  const reason=!seen.has(node.id)?'missing':invalid.get(node.id);
  if(reason)issues.push({paragraph:node.id,reference:'paragraph',reason});
 }
 // Do not emit a model-supplied ID, even if it resembles an expected one.
 // Repeated unassignable records need only one diagnostic per fixed category.
 const unassignable=[...new Map(sectionIssues.map(issue=>[issue.reason,issue])).values()];
 if(unassignable.length||issues.length){
  // A replacement with the wrong ID often leaves a source-owned slot missing.
  // Regenerate ALL missing slots from source, not from the unassignable record;
  // keep independently valid nodes. Without missing slots there is no safe
  // local target for an extra record, so regenerate the current section once.
  const scope=unassignable.length&&!issues.some(issue=>issue.reason==='missing')?'section':'paragraphs';
  throw new TextPatchValidationError(result,[...unassignable,...issues],scope);
 }
 return result;
}
