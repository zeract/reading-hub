import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import { createReaderMarkdown } from "../shared/markdown";
import { mathAt } from "../shared/markdown-math";
import { RewriteContentError } from "./rewrite-content";

const markdown = new MarkdownIt({html:false});
type Atom = { id:string; kind:"formula"|"image"|"code"|"reference"; source:string };
type Link = { id:string; label:string; destination:string };
export interface ProtectedRewrite { text:string; atoms:Atom[]; links:Link[]; prefix:string }
const escaped = (text:string, at:number) => { let n=0; while(at>0 && text[--at]==="\\") n++; return n%2===1; };

/** Read a complete Markdown link, including escaped labels and balanced destinations. */
export function rewriteLinkAt(text:string, start:number): {end:number; label:string; destination:string; image:boolean}|undefined {
  const image=text.startsWith("![",start); const begin=start+(image?1:0);
  if(text[begin]!=="[" || escaped(text,start))return;
  let depth=1, close=begin+1;
  for(;close<text.length;close++) {
    if(escaped(text,close))continue;
    if(text[close]==="[")depth++;
    if(text[close]==="]" && --depth===0)break;
  }
  if(text[close+1]!=="(")return;
  let end=close+2; depth=1; let angle=false;
  for(;end<text.length;end++) {
    if(escaped(text,end))continue;
    const c=text[end];
    if(c==="<")angle=true;else if(c===">")angle=false;
    else if(!angle && c==="(")depth++;
    else if(!angle && c===")" && --depth===0)break;
  }
  if(depth!==0)return;
  const tokens=markdown.parseInline(text.slice(start,end+1),{})[0]?.children;
  const token=tokens?.[0];
  if(image ? token?.type!=="image" || tokens?.length!==1 : token?.type!=="link_open" || tokens?.at(-1)?.type!=="link_close")return;
  const destination=token?.attrGet(image?"src":"href");
  if(!destination)return;
  return {end:end+1,label:text.slice(begin+1,close),destination:String(destination),image};
}

/** Freeze structural assets while leaving link anchor text available for translation. */
export function protectRewriteAssets(source:string, namespace=""): ProtectedRewrite {
  let prefix=`RH${createHash("sha256").update(namespace+source).digest("hex").slice(0,8)}_`;
  while(source.includes(`⟦${prefix}`))prefix+="X";
  const atoms:Atom[]=[], links:Link[]=[]; let text="", i=0;
  const atom=(kind:Atom["kind"],end:number)=>{const id=`${prefix}A${atoms.length+1}`;atoms.push({id,kind,source:source.slice(i,end)});text+=`⟦${id}⟧`;i=end;};
  while(i<source.length) {
    if(i===0 || source[i-1]==="\n") {
      const fence=/^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(source.slice(i));
      if(fence){const end=new RegExp("^ {0,3}"+fence[1][0]+"{"+fence[1].length+",}[ \t]*(?:$|\n)","m").exec(source.slice(i+fence[0].length));if(end){atom("code",i+fence[0].length+end.index+end[0].replace(/\n$/,"").length);continue;}}
    }
    if(source[i]==="`") {const run=/^`+/.exec(source.slice(i))![0];const end=source.indexOf(run,i+run.length);if(end>=0){atom("code",end+run.length);continue;}}
    const link=rewriteLinkAt(source,i);
    if(link) {
      if(link.image || (/^[\s()[\]（）、.\d]+$/.test(link.label) && link.destination.includes("#")))atom(link.image?"image":"reference",link.end);
      else {
        const id=`${prefix}L${links.length+1}`;links.push({id,label:link.label,destination:link.destination});
        const nested=protectRewriteAssets(link.label);let label=nested.text;
        for(const asset of nested.atoms){const nextId=`${prefix}A${atoms.length+1}`;atoms.push({...asset,id:nextId});label=label.replace(`⟦${asset.id}⟧`,`⟦${nextId}⟧`);}
        text+=`⟦${id}⟧${label}⟦/${id}⟧`;i=link.end;
      }
      continue;
    }
    const math=!escaped(source,i)?mathAt(source,i):undefined;
    if(math){atom("formula",math.end);continue;}
    text+=source[i++];
  }
  return {text,atoms,links,prefix};
}

/** Local structural validation; no extra model roundtrip, no arbitrary text-to-link guesses. */
export function restoreRewriteAssets(draft:string, material:ProtectedRewrite):string {
  const invalid=()=>{throw new RewriteContentError("改写未完整保留原文的链接、公式或图片标记，未替换已有稿；请重试。已完成分段仍保留。");};
  let result=draft;
  for(const link of material.links) {
    const open=`⟦${link.id}⟧`,close=`⟦/${link.id}⟧`;
    if(result.split(open).length!==2 || result.split(close).length!==2)invalid();
    const start=result.indexOf(open),end=result.indexOf(close);
    if(end<start+open.length)invalid();
    const label=result.slice(start+open.length,end).trim();
    if(!label || [...label.matchAll(/⟦([^⟧]+)⟧/g)].some(m=>!material.atoms.some(a=>a.id===m[1])))invalid();
    // Escape only label syntax; the original destination never comes from the model.
    const safeLabel=label.replace(/\\([\[\]\\])/g,"$1").replace(/[\\\[\]]/g,"\\$&").replace(/\s+/g," ");
    const url=link.destination.replace(/[<>\s]/g,c=>encodeURIComponent(c));
    result=result.slice(0,start)+`[${safeLabel}](<${url}>)`+result.slice(end+close.length);
  }
  for(const asset of material.atoms) {
    const marker=`⟦${asset.id}⟧`;
    if(result.split(marker).length!==2)invalid();
    result=result.replace(marker,()=>asset.source);
  }
  if(result.includes(`⟦${material.prefix}`)||result.includes(`⟦/${material.prefix}`))invalid();
  return result;
}

export function protectRewriteSection(blocks:ReadonlyArray<{id:string;text:string}>) {
  return blocks.map(block=>{
    const material=protectRewriteAssets(block.text,block.id),id=material.prefix+block.id;
    return {id:block.id,material,open:`⟦${id}⟧`,close:`⟦/${id}⟧`};
  });
}
const structureParser=createReaderMarkdown();
function structure(text:string):string {
  return structureParser.parse(text,{}).filter(t=>/^(heading|bullet_list|ordered_list|list_item|blockquote|table|thead|tbody|tr|th|td)_/.test(t.type)).map(t=>`${t.type}:${t.tag}:${t.attrGet("start")||""}`).join("|");
}
/** Bind links/media to their source block; language changes must not move assets to another paragraph. */
export function restoreRewriteBlocks(answer:string,blocks:ReturnType<typeof protectRewriteSection>):string[] {
  let remaining=answer;const result:string[]=[];
  for(const block of blocks){
    const start=remaining.indexOf(block.open),end=remaining.indexOf(block.close);
    if(start<0 || end<start || remaining.slice(0,start).trim() || remaining.split(block.open).length!==2 || remaining.split(block.close).length!==2)throw new RewriteContentError("改写未完整保留正文段落结构，未替换已有稿；已完成分段仍保留。");
    const draft=remaining.slice(start+block.open.length,end).trim();
    if(!draft || structure(block.material.text)!==structure(draft))throw new RewriteContentError("改写改变了标题、列表或表格结构，未替换已有稿；已完成分段仍保留。");
    result.push(restoreRewriteAssets(draft,block.material));remaining=remaining.slice(end+block.close.length);
  }
  if(remaining.trim())throw new RewriteContentError("改写包含无法归属原文的额外段落，未替换已有稿。");
  return result;
}
export function restoreRewriteSection(answer:string,blocks:ReturnType<typeof protectRewriteSection>):string {
  return restoreRewriteBlocks(answer,blocks).join("\n\n");
}
