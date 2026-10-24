import {articleDocumentText, documentTextNodes, type ArticleDocument,type ArticleNode} from '../shared/article-document';
import {RewriteContentError} from './rewrite-content';
export class ParagraphReferenceError extends RewriteContentError {
 constructor(readonly paragraphId:string,readonly referenceId:string='paragraph',readonly reason:'missing'|'duplicate'|'nesting'|'token-kind'|'unclosed'|'empty'|'syntax'='syntax'){super(`段落 ${paragraphId} 的行内引用校验失败（${referenceId}/${reason}），已完成分节仍保留。`);}
}
export interface ParagraphReferenceIssue {paragraph:string;reference:string;reason:ParagraphReferenceError['reason']}
/** A section gets one repair request, so collect one diagnostic per affected
 * paragraph before consuming that budget. Never return a partially restored tree. */
export class ParagraphReferenceValidationError extends RewriteContentError {
 constructor(readonly issues:ParagraphReferenceIssue[],message:string){super(message);}
}
const inlineTags=new Set(['a','strong','b','em','i','span','sup','sub','s','del','u','br','small','mark']);
type ReferencePart=string|{ref:string;parts:ReferencePart[]}|{ref:string};
const inline=(n:ArticleNode):boolean=>n.type==='text'||n.type==='asset'&&!n.display&&n.kind!=='image'&&n.kind!=='video'&&n.element.tag!=='pre'||n.type==='element'&&inlineTags.has(n.tag)&&n.children.every(inline);
const visible=(node:ArticleNode)=>articleDocumentText({version:1,provenance:'source',children:[node]}).trim();
const joinWithoutDoubleSpace=(left:string,right:string)=>left.endsWith(' ')&&right.startsWith(' ')?left+right.replace(/^[ \t]+/,''):left+right;
/** The model owns prose, not link identity. An exact adjacent echo of a link
 * label is redundant only when the authored source did not repeat it there. */
function removeEchoedLinkLabels(nodes:ArticleNode[],sourceNodes:ArticleNode[]):void {
 const sourceRepeats=new Map<string,{before:boolean;after:boolean}>();
 const index=(siblings:ArticleNode[])=>{
  siblings.forEach((node,i)=>{
   if(node.type!=='element')return;
   if(node.tag==='a'){
    const label=visible(node);
    const previous=siblings[i-1],following=siblings[i+1];
    sourceRepeats.set(node.id,{
     before:previous?.type==='text' && previous.text.trimEnd().endsWith(label),
     after:following?.type==='text' && following.text.trimStart().startsWith(label)
    });
   }
   index(node.children);
  });
 };
 index(sourceNodes);
 const clean=(siblings:ArticleNode[])=>{
  siblings.forEach((node,i)=>{
   if(node.type!=='element')return;
   if(node.tag==='a'){
    const label=visible(node),original=sourceRepeats.get(node.id);
    // Numeric/one-character anchors often identify footnotes or equations;
    // adjacent equal prose may be a separate reference, not a model echo.
    if(label.length>=2 && !/^\d+$/.test(label) && original){
     const before=siblings[i-1],after=siblings[i+1];
     if(!original.before && before?.type==='text'){
      const end=before.text.trimEnd().length;
      const prefix=before.text.slice(0,end-label.length);
      if(before.text.slice(0,end).endsWith(label) && (!/^[\x00-\x7f]+$/.test(label)||!/[A-Za-z0-9]$/.test(prefix)))before.text=joinWithoutDoubleSpace(prefix,before.text.slice(end));
     }
     if(!original.after && after?.type==='text'){
      const start=after.text.length-after.text.trimStart().length;
      const suffix=after.text.slice(start+label.length);
      if(after.text.slice(start).startsWith(label) && (!/^[\x00-\x7f]+$/.test(label)||!/[A-Za-z0-9]/.test(suffix[0]||'')))after.text=joinWithoutDoubleSpace(after.text.slice(0,start),suffix);
     }
    }
   }
   clean(node.children);
  });
 };
 clean(nodes);
}
/** A paragraph is editable language; source-owned inline references remain typed
 * objects. Reference order may change only inside that paragraph. */
export function prepareRewriteParagraphs(source:ArticleDocument) {
 const document=structuredClone(source);
 const groups=new Map<string,{refs:Map<string,ArticleNode>;parents:Map<string,string|undefined>;source:ArticleNode[]}>();
 const group=(children:ArticleNode[],owner:string):ArticleNode[]=>{
  if(!documentTextNodes({version:1,provenance:'source',children}).length || !children.every(inline))return children;
  const refs=new Map<string,ArticleNode>(),parents=new Map<string,string|undefined>();
  const encode=(n:ArticleNode,parent?:string):string=>{
   if(n.type==='text')return n.text.replace(/⟦/g,'⟦literal-open⟧');
   refs.set(n.id,n);parents.set(n.id,parent);
   return n.type==='element'&&n.tag!=='br'?`⟦${n.id}⟧${n.children.map(c=>encode(c,n.id)).join('')}⟦/${n.id}⟧`:`⟦${n.id}/⟧`;
  };
  const text=children.map(n=>encode(n)).join('');const id=`${owner}.text`;
  groups.set(id,{refs,parents,source:children});return [{type:'text',id,text}];
 };
 const visit=(n:ArticleNode)=>{
  if(n.type==='card'){n.title=group(n.title,n.id);return;}
  if(n.type!=='element')return;
  if(n.children.every(inline)){n.children=group(n.children,n.id);return;}
  n.children.forEach(visit);
 };
 document.children.forEach(visit);
 const restore=(draft:ArticleDocument):ArticleDocument=>{
  const result=structuredClone(draft);
  const errors:ParagraphReferenceError[]=[];
  const expand=(n:ArticleNode):ArticleNode[]=>{
   if(n.type==='text'&&groups.has(n.id)){
    try {
    const {refs,parents,source:original}=groups.get(n.id)!;const seen=new Set<string>();let next=0;
    const root:ArticleNode[]=[];const stack:Array<{id?:string;children:ArticleNode[]}>= [{children:root}];
    const fail=(id='paragraph',reason:ParagraphReferenceError['reason']='syntax')=>{throw new ParagraphReferenceError(n.id,id,reason);};
    const append=(text:string)=>{if(text)stack.at(-1)!.children.push({type:'text',id:`${n.id}.${++next}`,text});};
    let offset=0;
    for(const match of n.text.matchAll(/⟦([^⟦⟧]*)⟧/g)){
     append(n.text.slice(offset,match.index));offset=match.index!+match[0].length;
     const token=match[1];if(token==='literal-open'){append('⟦');continue;}
     if(token.startsWith('/')){if(stack.length===1||stack.at(-1)!.id!==token.slice(1))fail(refs.has(token.slice(1))?token.slice(1):'unknown','nesting');stack.pop();continue;}
     const single=token.endsWith('/'),id=single?token.slice(0,-1):token,original=refs.get(id);
     if(!original)fail('unknown','syntax');
     if(seen.has(id))fail(id,'duplicate');
     if(parents.get(id)!==stack.at(-1)!.id)fail(id,'nesting');
     seen.add(id);
     if(single){if(original!.type==='element'&&original!.tag!=='br')fail(id,'token-kind');stack.at(-1)!.children.push(structuredClone(original!));}
     else {if(original!.type!=='element'||original!.tag==='br')fail(id,'token-kind');const node={...structuredClone(original!),children:[]} as Extract<ArticleNode,{type:'element'}>;stack.at(-1)!.children.push(node);stack.push({id,children:node.children});}
    }
    append(n.text.slice(offset));
    if(stack.length!==1)fail(stack.at(-1)!.id!,'unclosed');
    for(const id of refs.keys())if(!seen.has(id))fail(id,'missing');
    if(n.text.replace(/⟦[^⟦⟧]*⟧/g,'').includes('⟦'))fail();
    const check=(node:ArticleNode)=>{if(node.type==='element'){if(node.tag==='a'&&!articleDocumentText({version:1,provenance:'rewrite',children:[node]}).trim())fail(node.id,'empty');node.children.forEach(check);}};root.forEach(check);
    removeEchoedLinkLabels(root,original);
    if(!articleDocumentText({version:1,provenance:'rewrite',children:root}).trim())fail('paragraph','empty');return root;
    } catch(error) {
     if(!(error instanceof ParagraphReferenceError))throw error;
     errors.push(error);return [n];
    }
   }
   if(n.type==='element')n.children=n.children.flatMap(expand);else if(n.type==='card')n.title=n.title.flatMap(expand);return [n];
  };
  result.children=result.children.flatMap(expand);
  if(errors.length)throw new ParagraphReferenceValidationError(errors.map(e=>({paragraph:e.paragraphId,reference:e.referenceId,reason:e.reason})),errors[0].message);
  return result;
 };
 const context=[...groups].flatMap(([id,g])=>[...g.refs.values()].filter(n=>n.type==='asset').map(n=>({paragraph:id,id:n.id,kind:n.type==='asset'?n.kind:'',text:articleDocumentText({version:1,provenance:'source',children:[n]}).slice(0,240)})));
 const references=(ids:Set<string>)=>[...groups].filter(([id])=>ids.has(id)).flatMap(([paragraph,g])=>[...g.refs].map(([id,n])=>({paragraph,id,kind:n.type==='asset'?n.kind:n.type==='element'?n.tag:'text',parent:g.parents.get(id)||null,open:n.type==='element'&&n.tag!=='br'?`⟦${id}⟧`:`⟦${id}/⟧`,close:n.type==='element'&&n.tag!=='br'?`⟦/${id}⟧`:null})));
 // Explanatory metadata is bounded independently of the complete markers in
 // paragraph text. A local repair automatically gets its own reference budget.
 const boundedReferences=(ids:Set<string>)=>{let remaining=6000;return references(ids).filter(ref=>{const size=JSON.stringify(ref).length;if(size>remaining)return false;remaining-=size;return true;});};
 /** The repair response carries complete subtrees, never handwritten closing
  * tokens. Canonical markers remain the checkpoint format and still pass the
  * same strict ownership/count/parent validator; no missing boundary is guessed. */
 const toParts=(node:{id:string;text:string}):ReferencePart[]=>{
  const encode=(n:ArticleNode):ReferencePart=>n.type==='text'?n.text:n.type==='element'&&n.tag!=='br'
   ?{ref:n.id,parts:n.children.map(encode)}:{ref:n.id};
  return groups.get(node.id)?.source.map(encode) ?? [node.text];
 };
 const fromParts=(paragraph:string,parts:unknown):string=>{
  const refs=groups.get(paragraph)?.refs;
  let count=0;
  const fail=(reference='paragraph',reason:ParagraphReferenceError['reason']='syntax'):never=>{throw new ParagraphReferenceError(paragraph,reference,reason);};
  const encode=(value:unknown,depth:number):string=>{
   if(depth>100||!Array.isArray(value))return fail();
   return value.map((part:unknown):string=>{
    if(++count>100000)return fail();
    if(typeof part==='string')return refs?part.replace(/⟦/g,'⟦literal-open⟧'):part;
    if(!part||typeof part!=='object'||Array.isArray(part)||!('ref' in part)||typeof part.ref!=='string')return fail();
    const original=refs?.get(part.ref);
    if(!original)return fail('unknown');
    const paired=original.type==='element'&&original.tag!=='br';
    if(Object.keys(part).length!==(paired?2:1)||paired&&!('parts' in part)||!paired&&'parts' in part)return fail(part.ref,'token-kind');
    return paired&&'parts' in part?`⟦${part.ref}⟧${encode(part.parts,depth+1)}⟦/${part.ref}⟧`:`⟦${part.ref}/⟧`;
   }).join('');
  };
  return encode(parts,0);
 };
 return {document,restore,context,references:boundedReferences,toParts,fromParts};
}
