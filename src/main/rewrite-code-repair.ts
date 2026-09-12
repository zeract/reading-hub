import {articleDocumentText,type ArticleDocument,type ArticleNode} from '../shared/article-document';
import type {RewriteResult} from '../shared/rewrite';
import {createReaderMarkdown} from '../shared/markdown';
import {articleDocumentFromMarkdown} from './article-document';
import {indexLegacyRewrite} from './rewrite-document';
/** Legacy JSON paragraphs are repairable only when their parsed value exactly
 * matches one source-owned code block. No translation, fuzzy matching or guessing. */
export function repairLegacyJsonCode(result:RewriteResult,source:ArticleDocument):{result:RewriteResult;repaired:number} {
 if(result.promptVersion>=12)return {result,repaired:0};
 const codes=new Map<string,string[]>();
 const identity=(text:string)=>{try{const value=JSON.parse(text);return value&&typeof value==='object'?JSON.stringify(value):undefined;}catch{return undefined;}};
 const visit=(n:ArticleNode)=>{if(n.type==='asset'&&n.kind==='code'&&n.element.tag==='pre'){
  const text=articleDocumentText({version:1,provenance:'source',children:[n]}),key=identity(text);if(key)codes.set(key,[...(codes.get(key)||[]),text]);
 }else if(n.type==='element')n.children.forEach(visit);};source.children.forEach(visit);
 const lines=result.markdown.split('\n'),offsets=[0];for(const line of lines)offsets.push(offsets.at(-1)!+line.length+1);
 const edits:Array<{start:number;end:number;text:string}>=[];
 for(const token of createReaderMarkdown().parse(result.markdown,{})){
  if(token.type!=='paragraph_open'||token.level!==0||!token.map)continue;
  const start=offsets[token.map[0]],end=Math.min(result.markdown.length,offsets[token.map[1]]);
  const text=result.markdown.slice(start,end).trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g,'$1');
  const key=identity(text),matches=key?codes.get(key):undefined;if(matches?.length!==1)continue;
  edits.push({start,end,text:'```json\n'+matches[0].trim()+'\n```\n'});
 }
 if(!edits.length)return {result,repaired:0};
 let markdown=result.markdown;for(const e of edits.reverse())markdown=markdown.slice(0,e.start)+e.text+markdown.slice(e.end);
 return {result:{...result,markdown,content:articleDocumentFromMarkdown(markdown),document:indexLegacyRewrite(markdown)},repaired:edits.length};
}
