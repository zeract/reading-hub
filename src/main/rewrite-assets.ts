import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import { createReaderMarkdown } from "../shared/markdown";
import { mathAt } from "../shared/markdown-math";
import { RewriteContentError } from "./rewrite-content";

const markdown = new MarkdownIt({html:false});
type Atom = { id:string; kind:"formula"|"image"|"code"|"reference"; source:string; range?:[number,number] };
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
  let prefix=/^B[1-9]\d*$/.test(namespace) ? `${namespace}_` : `RH${createHash("sha256").update(namespace+source).digest("hex").slice(0,8)}_`;
  while(source.includes(`⟦${prefix}`))prefix+="X";
  const atoms:Atom[]=[], links:Link[]=[]; let text="", i=0;
  const atom=(kind:Atom["kind"],end:number)=>{const id=`${prefix}A${atoms.length+1}`;atoms.push({id,kind,source:source.slice(i,end),range:[i,end]});text+=`⟦${id}⟧`;i=end;};
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
        for(const asset of nested.atoms){const nextId=`${prefix}A${atoms.length+1}`;atoms.push({...asset,id:nextId,range:undefined});label=label.replace(`⟦${asset.id}⟧`,`⟦${nextId}⟧`);}
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

type AssetFailure = "missing" | "duplicate" | "order" | "label" | "unknown";
export class RewriteAssetError extends RewriteContentError {
  constructor(readonly assetId:string, readonly assetKind:string, readonly failure:AssetFailure) {
    super(`改写未完整保留原文资产（${assetId}，${assetKind}，${failure}）；已有稿及已完成分节仍保留。`);
    this.name="RewriteAssetError";
  }
}
function inlineCodeValue(source:string):string|undefined {
  if(source.includes("\n"))return;
  const tokens=markdown.parseInline(source,{})[0]?.children;
  return tokens?.length===1 && tokens[0].type==="code_inline" ? tokens[0].content : undefined;
}
/** Accept an unchanged Markdown asset as another explicit representation
 * of that block's asset. Only inline-code whitespace follows Markdown semantics;
 * other assets must match exactly. Never infer assets from prose or reassign foreign IDs. */
function normalizeLiteralAssets(draft:string, material:ProtectedRewrite, strict:boolean):string {
  const candidates=protectRewriteAssets(draft).atoms.filter(a=>a.range);
  const value=(a:Atom)=>JSON.stringify([a.kind,a.kind==="code" && inlineCodeValue(a.source)!==undefined ? "inline" : "exact",a.kind==="code" ? inlineCodeValue(a.source) ?? a.source : a.source]);
  const groups=new Map<string,Atom[]>();
  for(const asset of material.atoms) {
    const key=value(asset);
    if(key!==undefined){const group=groups.get(key)||[];group.push(asset);groups.set(key,group);}
  }
  // A code block copied from context must not reappear in another prose block.
  // Formula synthesis from explicit plain-text maths remains supported.
  for(const candidate of candidates)if((candidate.kind==="code" || strict && ["image","reference"].includes(candidate.kind)) && !groups.has(value(candidate)))throw new RewriteAssetError("literal",candidate.kind,"unknown");
  const edits:Array<{start:number;end:number;text:string}>=[];
  for(const [key,assets] of groups) {
    const missing=assets.filter(a=>!draft.includes(`⟦${a.id}⟧`));
    const literals=candidates.filter(a=>value(a)===key);
    if(!literals.length)continue;
    if(literals.length>missing.length)throw new RewriteAssetError(assets[0].id,assets[0].kind,"duplicate");
    // An incomplete/ambiguous set remains a failure; do not guess where other
    // copies belong or repair an altered identifier such as intent.md -> spec.md.
    if(literals.length!==missing.length)continue;
    literals.forEach((literal,i)=>edits.push({start:literal.range![0],end:literal.range![1],text:`⟦${missing[i].id}⟧`}));
  }
  let result=draft;
  for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  return result;
}

/** Model-facing links use ordinary Markdown with a source-owned ID as destination.
 * The internal paired representation remains private to legacy repair and asset restoration. */
export function rewriteModelText(material:ProtectedRewrite):string {
  let text=material.text;
  for(const link of material.links) {
    const open=`⟦${link.id}⟧`,close=`⟦/${link.id}⟧`;
    const start=text.indexOf(open),end=text.indexOf(close);
    text=text.slice(0,start)+`[${text.slice(start+open.length,end)}](${link.id})`+text.slice(end+close.length);
  }
  return text;
}

/** Normalize explicit Markdown links only. Never infer an anchor from nearby prose.
 * Exact source URLs are accepted as well as IDs; unknown destinations cannot enter a draft. */
function normalizeModelLinks(draft:string, material:ProtectedRewrite):string {
  const opaque=protectRewriteAssets(draft).atoms.filter(a=>a.range);
  const found:Array<{start:number;end:number;label:string;destination:string}>=[];
  for(let i=0;i<draft.length;) {
    const atom=opaque.find(a=>a.range![0]===i);
    if(atom){i=atom.range![1];continue;}
    const link=rewriteLinkAt(draft,i);
    if(link && !link.image){found.push({start:i,...link});i=link.end;}else i++;
  }
  const used=new Set(material.links.filter(l=>draft.includes(`⟦${l.id}⟧`) || draft.includes(`⟦/${l.id}⟧`)).map(l=>l.id));
  const edits:Array<{start:number;end:number;text:string}>=[];
  // Claim explicit IDs first so identical original URLs cannot steal their occurrence.
  for(const candidate of [...found].sort((a,b)=>Number(material.links.some(l=>l.id===b.destination))-Number(material.links.some(l=>l.id===a.destination)))) {
    const matches=material.links.filter(l=>l.id===candidate.destination || l.destination===candidate.destination);
    const link=matches.find(l=>!used.has(l.id));
    if(!link)throw new RewriteAssetError(matches[0]?.id || "literal","link",matches.length ? "duplicate" : "unknown");
    if(!candidate.label.trim())throw new RewriteAssetError(link.id,"link","label");
    used.add(link.id);
    edits.push({start:candidate.start,end:candidate.end,text:`⟦${link.id}⟧${candidate.label}⟦/${link.id}⟧`});
  }
  let result=draft;
  for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  return result;
}

/** Local structural validation; no extra model roundtrip, no arbitrary text-to-link guesses. */
export function restoreRewriteAssets(draft:string, material:ProtectedRewrite, modelOutput=false):string {
  const invalid=(id:string,kind:string,reason:AssetFailure):never=>{throw new RewriteAssetError(id,kind,reason);};
  let result=normalizeLiteralAssets(modelOutput ? normalizeModelLinks(draft,material) : draft,material,modelOutput);
  if(modelOutput)for(const match of result.matchAll(/⟦[^⟦⟧]+⟧/g)) {
    if(!material.text.includes(match[0]))invalid(material.prefix,"marker","unknown");
  }
  for(const link of material.links) {
    const open=`⟦${link.id}⟧`,close=`⟦/${link.id}⟧`;
    if(!result.includes(open) || !result.includes(close))invalid(link.id,"link","missing");
    if(result.split(open).length!==2 || result.split(close).length!==2)invalid(link.id,"link","duplicate");
    const start=result.indexOf(open),end=result.indexOf(close);
    if(end<start+open.length)invalid(link.id,"link","order");
    const label=result.slice(start+open.length,end).trim();
    if(!label || [...label.matchAll(/⟦([^⟧]+)⟧/g)].some(m=>!material.atoms.some(a=>a.id===m[1])))invalid(link.id,"link","label");
    // Escape only label syntax; the original destination never comes from the model.
    const safeLabel=label.replace(/\\([\[\]\\])/g,"$1").replace(/[\\\[\]]/g,"\\$&").replace(/\s+/g," ");
    const url=link.destination.replace(/[<>\s]/g,c=>encodeURIComponent(c));
    result=result.slice(0,start)+`[${safeLabel}](<${url}>)`+result.slice(end+close.length);
  }
  for(const asset of material.atoms) {
    const marker=`⟦${asset.id}⟧`;
    if(!result.includes(marker))invalid(asset.id,asset.kind,"missing");
    if(result.split(marker).length!==2)invalid(asset.id,asset.kind,"duplicate");
    result=result.replace(marker,()=>asset.source);
  }
  if(result.includes(`⟦${material.prefix}`)||result.includes(`⟦/${material.prefix}`))invalid(material.prefix,"marker","unknown");
  return result;
}

export function protectRewriteSection(blocks:ReadonlyArray<{id:string;text:string}>) {
  return blocks.map(block=>({id:block.id,material:protectRewriteAssets(block.text,block.id)}));
}
/** Whole immutable blocks have no language for the model to rewrite. */
export function isFixedRewriteBlock(block:ReturnType<typeof protectRewriteSection>[number]):boolean {
  return block.material.atoms.length===1 && !block.material.links.length
    && block.material.text.trim()===`⟦${block.material.atoms[0].id}⟧`;
}
const structureParser=createReaderMarkdown();
function structure(text:string):string {
  return structureParser.parse(text,{}).filter(t=>/^(heading|bullet_list|ordered_list|list_item|blockquote|table|thead|tbody|tr|th|td)_/.test(t.type)).map(t=>`${t.type}:${t.tag}:${t.attrGet("start")||""}`).join("|");
}
export type RewriteProtocolCode = "response-format" | "missing-block" | "duplicate-block" | "unknown-block" | "empty-block" | "block-shape" | "asset-marker";
const protocolMessages: Record<RewriteProtocolCode,string> = {
  "response-format":"须返回完整的 blocks JSON 数据", "missing-block":"缺少正文块", "duplicate-block":"正文块重复", "unknown-block":"存在未知正文块",
  "empty-block":"段落内容为空", "block-shape":"标题、列表或表格结构发生变化", "asset-marker":"链接、公式、代码或图片标记不完整"
};
/** Diagnostics contain only program-owned IDs and categories, never model text. */
export class RewriteProtocolError extends RewriteContentError {
  constructor(readonly code:RewriteProtocolCode, readonly blockId:string, detail?:RewriteAssetError) {
    super(`正文段落结构校验失败（${blockId}：${protocolMessages[code]}；${code}${detail ? `：${detail.assetId}/${detail.assetKind}/${detail.failure}` : ""}），未替换已有稿；已完成分段仍保留。`);
    this.name="RewriteProtocolError";
  }
}

/** The response is data, not a custom stream of paired delimiters. IDs define source
 * position; array order is immaterial. Reject incomplete/extra data before checkpointing. */
export function restoreRewriteBlocks(answer:string,blocks:ReturnType<typeof protectRewriteSection>):string[] {
  const fail=(code:RewriteProtocolCode,id="response"):never=>{throw new RewriteProtocolError(code,id);};
  const text=answer.trim();
  const fenced=/^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n\1[ \t]*$/i.exec(text);
  let parsed:any;
  try{parsed=JSON.parse(fenced ? fenced[2] : text);}catch{return fail("response-format");}
  if(!parsed || typeof parsed!=="object" || Array.isArray(parsed) || Object.keys(parsed).length!==1 || !Array.isArray(parsed.blocks))return fail("response-format");
  const expected=new Set(blocks.map(b=>b.id));const values=new Map<string,string>();
  for(const b of parsed.blocks) {
    if(!b || typeof b!=="object" || Array.isArray(b) || Object.keys(b).length!==2 || typeof b.id!=="string" || typeof b.text!=="string")return fail("response-format");
    if(!expected.has(b.id))return fail("unknown-block");
    if(values.has(b.id))return fail("duplicate-block",b.id);
    if(!b.text.trim())return fail("empty-block",b.id);
    values.set(b.id,b.text.trim());
  }
  return blocks.map(block=>{
    const draft=values.get(block.id);if(draft===undefined)return fail("missing-block",block.id);
    if(structure(block.material.text)!==structure(draft))return fail("block-shape",block.id);
    try{return restoreRewriteAssets(draft,block.material,true);}
    catch(error){if(error instanceof RewriteAssetError)throw new RewriteProtocolError("asset-marker",block.id,error);throw error;}
  });
}
