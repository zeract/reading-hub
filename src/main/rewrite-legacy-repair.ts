import { mathAt } from "../shared/markdown-math";
import MarkdownIt from "markdown-it";
import {protectRewriteAssets,restoreRewriteAssets,rewriteLinkAt} from "./rewrite-assets";
import {throwIfAborted} from "./cancellation";
import type {RewriteRunner} from "./rewrite-pipeline";

const parser=new MarkdownIt({linkify:true});
const labelText=(label:string)=>label.replace(/\\([\[\]\\])/g,"$1");
const anchor=(label:string,url:string)=>`[${label.replace(/[\\\[\]]/g,"\\$&")}](<${url.replace(/[<>\s]/g,c=>encodeURIComponent(c))}>)`;
type RepairLink={id:string;start:number;end:number;url:string;labels:string[]};

/** Explicit maintenance only: align legacy anchors against source links, never infer them by character count. */
export async function repairLegacyRewrite(source:string,drafts:string[],run:RewriteRunner,signal:AbortSignal,imageAliases:ReadonlyArray<{url:string;markdown:string}>=[]) {
 const original=protectRewriteAssets(source);
 const labels=new Map<string,string[]>(),images=new Map<string,string>();
 for(const link of original.links)labels.set(link.destination,[...new Set([...(labels.get(link.destination)||[]),labelText(link.label)])]);
 for(const asset of original.atoms) {
  const link=rewriteLinkAt(asset.source,0);
  if(link?.image)images.set(link.destination,asset.source);
  else if(link)labels.set(link.destination,[labelText(link.label)]);
 }
 for(const alias of imageAliases){const image=rewriteLinkAt(alias.markdown,0);if(image?.image && images.has(image.destination))images.set(alias.url,alias.markdown);}
 const formulaKey=(value:string)=>{const match=mathAt(value,0);return match?.tex.replace(/\\(?:tag\*?|label)\{[^{}]*\}/g,"").replace(/\s+/g," ").trim();};
 const formulas=new Map<string,Set<string>>();
 for(const atom of original.atoms)if(atom.kind==="formula"){const key=formulaKey(atom.source);if(key){const values=formulas.get(key)||new Set<string>();values.add(atom.source);formulas.set(key,values);}}
 let formulaCount=0,linked=0,imageCount=0,unknown=0,fallback=0,requests=0;
 const sections:string[]=[];
 const documents:Array<{protectedDraft:ReturnType<typeof protectRewriteAssets>;paragraphs:string[]}>=[];
 const work:Array<{document:number;paragraph:number;text:string;links:RepairLink[];edits:Array<{start:number;end:number;text:string}>}>=[];
 for(const draft of drafts) {
  throwIfAborted(signal);
  const protectedDraft=protectRewriteAssets(draft);
  for(const atom of protectedDraft.atoms)if(atom.kind==="formula" && !/\\tag\*?\{/.test(atom.source)) {
   const candidates=formulas.get(formulaKey(atom.source)||"");
   if(candidates?.size===1){const source=[...candidates][0];if(/\\tag\*?\{/.test(source)){atom.source=source;formulaCount++;}}
  }
  // Existing links and code stay opaque; formula numbers require a unique exact source formula.
  const paragraphs=protectedDraft.text.split(/\n\n/);
  documents.push({protectedDraft,paragraphs});
  for(let paragraphIndex=0;paragraphIndex<paragraphs.length;paragraphIndex++) {
   const text=paragraphs[paragraphIndex];
   const matches=parser.linkify.match(text)||[];
   if(!matches.length)continue;
   const links:RepairLink[]=[],edits:Array<{start:number;end:number;text:string}>=[];
   for(const match of matches) {
    let url=match.url,start=match.index,end=match.lastIndex;
    if(!images.has(url) && !labels.has(url)) {
     // Repair whitespace-broken citations only when the entire URL matches a declared source target.
     for(const target of [...images.keys(),...labels.keys()].sort((a,b)=>b.length-a.length)) {
      let cursor=start,matched=true,spaces=0;
      for(const char of target){while(/\s/.test(text[cursor]||"") && cursor<text.length){cursor++;spaces++;}if(text[cursor++]!==char){matched=false;break;}}
      if(matched && spaces>0 && (cursor===text.length || /[\s)）]/.test(text[cursor]))) {url=target;end=cursor;break;}
     }
     const declared=[...images.keys(),...labels.keys()].filter(u=>match.text.startsWith(u) && /^[)）]/.test(match.text.slice(u.length))).sort((a,b)=>b.length-a.length)[0];
     if(declared && url===match.url){url=declared;end=start+declared.length;}
    }
    if((text[start-1]==="("&&text[end]===")")||(text[start-1]==="（"&&text[end]==="）")){start--;end++;}
    const image=images.get(url);
    if(image){edits.push({start,end,text:image});imageCount++;continue;}
    const sourceLabels=labels.get(url);
    if(!sourceLabels){unknown++;continue;}
    links.push({id:`P${work.length+1}L${links.length+1}`,start,end,url,labels:sourceLabels});
   }
   work.push({document:documents.length-1,paragraph:paragraphIndex,text,links,edits});
  }
 }
 const answers=new Map<string,{anchor?:string;label?:string}>();
 const jobs=work.filter(w=>w.links.length);
 for(let i=0;i<jobs.length;) {
  const batch:typeof jobs=[];let size=0;
  while(i<jobs.length && (size<7000 || !batch.length)) {const job=jobs[i++];batch.push(job);size+=job.text.length+JSON.stringify(job.links).length;}
  const raw=await run("write",JSON.stringify({instruction:'修复中文旧稿的链接锚文本，不改写正文。对每个链接，依据 sourceLabels（同一目标在英文原文中的真实锚文本），在对应 paragraph 中找到对应的现有中文短语，anchor 必须逐字摘自该 paragraph 且不含网址。无法唯一确定时 anchor 返回 null，label 返回 sourceLabels 的简体中文翻译用于原链接位置。不要凭位置截取几个字，不要返回“链接”“来源”等泛称。只输出 JSON 数组 [{"id":"P1L1","anchor":"现有中文短语或null","label":"原锚文本的中文翻译"}]。',paragraphs:batch.map(w=>({paragraph:w.text,links:w.links.map(l=>({id:l.id,url:l.url,sourceLabels:l.labels}))}))}),signal);
  throwIfAborted(signal);requests++;
  try {const value=JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,""));if(Array.isArray(value))for(const answer of value)if(answer&&typeof answer.id==="string")answers.set(answer.id,answer);}catch{/* Source-backed labels remain available when a response is malformed. */}
 }
 for(const {text,links,edits,document,paragraph} of work) {
    for(const link of links) {
     const answer=answers.get(link.id);
     const phrase=typeof answer?.anchor==="string"?answer.anchor.trim():"";
     const at=phrase?text.indexOf(phrase):-1;
     const overlap=(start:number,end:number)=>edits.some(e=>start<e.end&&end>e.start)||links.some(l=>start<l.end&&end>l.start);
     if(at>=0 && phrase.length<=300 && text.indexOf(phrase,at+phrase.length)<0 && !/[⟦⟧]|https?:/.test(phrase) && !overlap(at,at+phrase.length)) {
      edits.push({start:at,end:at+phrase.length,text:anchor(phrase,link.url)},{start:link.start,end:link.end,text:""});linked++;
     } else {
      const translated=typeof answer?.label==="string"?answer.label.trim():"";
      const label=translated && translated.length<=300 && !/[⟦⟧]|https?:|[\r\n]/.test(translated) && !/^(链接|来源|参考)$/.test(translated)?translated:link.labels[0];
      edits.push({start:link.start,end:link.end,text:anchor(label,link.url)});fallback++;
     }
    }
   let repaired=text;
   for(const edit of edits.sort((a,b)=>b.start-a.start))repaired=repaired.slice(0,edit.start)+edit.text+repaired.slice(edit.end);
   documents[document].paragraphs[paragraph]=repaired;
 }
 for(const {paragraphs,protectedDraft} of documents)sections.push(restoreRewriteAssets(paragraphs.join("\n\n"),protectedDraft));
 return {sections,markdown:sections.join("\n\n"),report:{linked,images:imageCount,formulas:formulaCount,unknown,fallback,requests}};
}
