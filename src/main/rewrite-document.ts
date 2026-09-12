import {articleDocumentFromMarkdown,articleDocumentMarkdown} from "./article-document";
import {validArticleDocument} from "../shared/article-document";
import { createHash } from "node:crypto";
import { createReaderMarkdown } from "../shared/markdown";
import type { RewriteBlockRelation, RewriteDocument, RewriteResult } from "../shared/rewrite";
import { protectRewriteAssets } from "./rewrite-assets";

const parser = createReaderMarkdown();
export const documentHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Store identity/ownership, never source prose. Offsets refer to the exact saved Markdown. */
export function bindRewriteBlock(id: string, sectionId: string, source: string | undefined, target: string, start: number): RewriteBlockRelation {
  const protectedText = protectRewriteAssets(source ?? target, id);
  return { id, sectionId, start, end: start + target.length, hash: documentHash(target),
    type: parser.parse(target, {})[0]?.type || "text",
    ...(source === undefined ? {} : { sourceHash: documentHash(source) }),
    assets: [
      ...protectedText.atoms.map(a => ({id:a.id, kind:a.kind, hash:documentHash(a.source)})),
      ...protectedText.links.map(a => ({id:a.id, kind:"link" as const, hash:documentHash(a.destination), destination:a.destination}))
    ] };
}

/** A legacy draft establishes only its own structure, not guessed source correspondence. */
export function indexLegacyRewrite(markdown: string): RewriteDocument {
  const lines = markdown.split("\n"); const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  const ranges = parser.parse(markdown, {}).filter(t => t.level === 0 && t.map && t.nesting !== -1);
  return {version:1, provenance:"derived-only", blocks:ranges.map((t,i) => {
    const start=offsets[t.map![0]], end=Math.min(markdown.length, offsets[t.map![1]]);
    return bindRewriteBlock(`D${i+1}`, "legacy", undefined, markdown.slice(start,end), start);
  })};
}

export function validRewriteDocument(value: unknown, markdown: string): value is RewriteDocument {
  const v=value as RewriteDocument | undefined;
  if (!v || v.version!==1 || !["source-bound","derived-only"].includes(v.provenance) || !Array.isArray(v.blocks) || v.blocks.length>10000) return false;
  const ids=new Set<string>(); let previous=0;
  const valid = v.blocks.every(b => {
    if (!b || typeof b.id!=="string" || ids.has(b.id) || typeof b.sectionId!=="string" || typeof b.type!=="string"
      || !Number.isInteger(b.start) || !Number.isInteger(b.end) || b.start<previous || b.end<=b.start || b.end>markdown.length
      || markdown.slice(previous,b.start).trim() || b.hash!==documentHash(markdown.slice(b.start,b.end)) || (v.provenance==="source-bound" && !/^[a-f0-9]{64}$/.test(b.sourceHash || ""))
      || !Array.isArray(b.assets) || b.assets.some(a=>!a || typeof a.id!=="string" || !["formula","image","code","reference","link"].includes(a.kind) || !/^[a-f0-9]{64}$/.test(a.hash) || (a.destination!==undefined && typeof a.destination!=="string"))) return false;
    ids.add(b.id); previous=b.end; return true;
  });
  return valid && !markdown.slice(previous).trim();
}

/** Versioned, lossless migration: retain unknown fields and all readable draft text. */
export function decodeRewriteResult(raw: string): RewriteResult {
  const v=JSON.parse(raw);
  if(v?.schemaVersion!==undefined && ![1,2].includes(v.schemaVersion))throw new Error("此改写由更新版本保存，请升级应用后读取。");
  if(v?.content!==undefined && !validArticleDocument(v.content))throw new Error("保存的正文结构无效，原始记录仍保留。");
  if(v?.content && typeof v.markdown!=="string")v.markdown=articleDocumentMarkdown(v.content);
  if (!v || typeof v!=="object" || typeof v.markdown!=="string" || !v.markdown.trim() || v.markdown.length>240000) throw new Error("保存的改写格式无效，原始记录仍保留。");
  for (const field of ["provider","model","sourceUrl","sourceTitle","sourceHash"]) if(typeof v[field]!=="string") throw new Error("保存的改写元数据无效，原始记录仍保留。");
  if (!Number.isFinite(v.createdAt) || !Number.isInteger(v.promptVersion)) throw new Error("保存的改写版本无效，原始记录仍保留。");

  if(v.sections!==undefined && (!Array.isArray(v.sections) || v.sections.some((s:unknown)=>typeof s!=="string") || v.sections.join("\n\n")!==v.markdown)) delete v.sections;
  if(v.content?.provenance==="rewrite" && v.promptVersion>=11)delete v.document;
  else if(!validRewriteDocument(v.document,v.markdown)) v.document=indexLegacyRewrite(v.markdown);
  return {...v,schemaVersion:2,content:v.content || articleDocumentFromMarkdown(v.markdown)};
}

/** New generated documents store the tree only; Markdown and its old offset index
 * are derived for exports/legacy IPC. Legacy text remains exact during migration. */
export function encodeRewriteResult(result:RewriteResult):string {
 const value={...result};
 if(value.schemaVersion===2 && value.content && value.content.provenance!=="legacy"){
  return JSON.stringify({...value,markdown:undefined,document:undefined,sections:undefined});
 }
 return JSON.stringify(value);
}
