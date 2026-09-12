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
  // Block IDs are short and document-local. Fall back to a source-derived
  // namespace only if authored text already contains a reserved block marker.
  let prefix="";
  while(blocks.some(b=>blocks.some(other=>b.text.includes(`⟦${prefix}${other.id}⟧`) || b.text.includes(`⟦/${prefix}${other.id}⟧`)))) prefix+="R";
  return blocks.map(block=>{
    const material=protectRewriteAssets(block.text,block.id),id=prefix+block.id;
    return {id:block.id,material,open:`⟦${id}⟧`,close:`⟦/${id}⟧`};
  });
}
const structureParser=createReaderMarkdown();
function structure(text:string):string {
  return structureParser.parse(text,{}).filter(t=>/^(heading|bullet_list|ordered_list|list_item|blockquote|table|thead|tbody|tr|th|td)_/.test(t.type)).map(t=>`${t.type}:${t.tag}:${t.attrGet("start")||""}`).join("|");
}
export type RewriteProtocolCode = "missing-open" | "missing-close" | "duplicate-marker" | "block-order" | "outside-text" | "empty-block" | "block-shape" | "asset-marker";
const protocolMessages: Record<RewriteProtocolCode,string> = {
  "missing-open":"缺少段落开始标记", "missing-close":"缺少段落结束标记", "duplicate-marker":"段落标记重复",
  "block-order":"段落标记顺序错误", "outside-text":"段落标记外存在内容", "empty-block":"段落内容为空",
  "block-shape":"标题、列表或表格结构发生变化", "asset-marker":"链接、公式、代码或图片标记不完整"
};
/** Diagnostics contain only program-owned IDs and categories, never model text. */
export class RewriteProtocolError extends RewriteContentError {
  constructor(readonly code:RewriteProtocolCode, readonly blockId:string) {
    super(`正文段落结构校验失败（${blockId}：${protocolMessages[code]}；${code}），未替换已有稿；已完成分段仍保留。`);
    this.name="RewriteProtocolError";
  }
}

function unwrapResponseFence(answer:string, blocks:ReturnType<typeof protectRewriteSection>):string {
  const text=answer.trim();
  const wrapped=/^(`{3,}|~{3,})(?:markdown|md)?[ \t]*\r?\n([\s\S]*)\r?\n\1[ \t]*$/i.exec(text);
  const inner=wrapped?.[2].trim();
  // Remove only an envelope surrounding the complete expected block stream.
  // Never strip explanation prose, a partial fence, or source code inside a block.
  return inner && blocks.length && inner.startsWith(blocks[0].open) && inner.endsWith(blocks.at(-1)!.close) ? inner : text;
}

/** Bind links/media to their source block; language changes must not move assets to another paragraph. */
export function restoreRewriteBlocks(answer:string,blocks:ReturnType<typeof protectRewriteSection>):string[] {
  let remaining=unwrapResponseFence(answer,blocks);const result:string[]=[];
  for(const block of blocks){
    const fail=(code:RewriteProtocolCode):never=>{throw new RewriteProtocolError(code,block.id);};
    const opens=remaining.split(block.open).length-1,closes=remaining.split(block.close).length-1;
    if(!opens)fail("missing-open");if(!closes)fail("missing-close");
    if(opens!==1 || closes!==1)fail("duplicate-marker");
    const start=remaining.indexOf(block.open),end=remaining.indexOf(block.close);
    if(end<start)fail("block-order");
    if(remaining.slice(0,start).trim())fail(blocks.some(b=>remaining.slice(0,start).includes(b.open)) ? "block-order" : "outside-text");
    const draft=remaining.slice(start+block.open.length,end).trim();
    if(!draft)fail("empty-block");
    if(structure(block.material.text)!==structure(draft))fail("block-shape");
    try {result.push(restoreRewriteAssets(draft,block.material));}
    catch(error){if(error instanceof RewriteContentError)fail("asset-marker");throw error;}
    remaining=remaining.slice(end+block.close.length);
  }
  if(remaining.trim())throw new RewriteProtocolError("outside-text",blocks.at(-1)?.id || "document");
  return result;
}
export function restoreRewriteSection(answer:string,blocks:ReturnType<typeof protectRewriteSection>):string {
  return restoreRewriteBlocks(answer,blocks).join("\n\n");
}
