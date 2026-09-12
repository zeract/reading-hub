import {load} from 'cheerio';
import {createReaderMarkdown} from '../shared/markdown';
import {articleDocumentTags,safeDocumentAttribute,validArticleDocument,articleDocumentHtml,type ArticleDocument,type ArticleNode,type ElementNode} from '../shared/article-document';
import {normalizeRewriteCards} from './rewrite-cards';
import type {ReaderArticle} from '../shared/types';
import katex from 'katex';
import {rewriteText} from './rewrite-content';
const parser=createReaderMarkdown();
/** Called after the existing extraction/security boundary. Defensive allowlists also
 * make legacy/model Markdown imports safe; no source CSS or raw HTML is persisted. */
export function articleDocumentFromHtml(html:string,provenance:ArticleDocument['provenance']='source'):ArticleDocument {
 const $=load(html,{},false);normalizeRewriteCards($,'mark');let next=0;let allocate=()=>`N${++next}`;
 const id=()=>allocate();
 const visit=(node:any,insideAsset=false):ArticleNode[]=>{
  if(node.type==='text')return [{type:'text',id:id(),text:node.data}];
  const tag=node.name;if(!tag || ['script','style','iframe','object','embed'].includes(tag))return [];
  if(!articleDocumentTags.has(tag))return (node.children||[]).flatMap((c:any)=>visit(c,insideAsset));
  const el=$(node);
  if(el.attr('data-reader-card')==='true'){
   const heading=el.find('h1,h2,h3,h4,h5,h6').first(),url=heading.closest('a').attr('href')!;
   const metadata=el.clone();metadata.find("a[href]").filter((_i,a)=>$(a).attr("href")===url).remove();metadata.find('img,picture').remove();
   return [{type:'card',id:id(),url,title:heading.contents().toArray().flatMap(n=>visit(n)),metadata:metadata.contents().toArray().flatMap(n=>visit(n)),image:el.find('img').first().attr('src')}];
  }
  const math=!insideAsset && el.is('[data-reader-equation],.katex-display,.katex,mjx-container,[data-reader-tex],.reader-math-source');
  const kind=math?'math':tag==='pre'||tag==='code'?'code':tag==='img'?'image':el.hasClass('reader-video')||tag==='video'?'video':undefined;
  const assetId=kind&&!insideAsset?id():undefined,previousAllocate=allocate;
  if(assetId){let local=0;allocate=()=>`${assetId}.P${++local}`;}
  const attributes:Record<string,string>={};
  for(const [key,value] of Object.entries(node.attribs||{}))if(typeof value==='string'&&safeDocumentAttribute(key,value))attributes[key]=value;
  if(tag==='img' && attributes.src)Object.assign(attributes,{loading:'lazy','data-reader-zoomable':'true',tabindex:'0',role:'button'});
  const element:ElementNode={type:'element',id:id(),tag,attrs:attributes,children:(node.children||[]).flatMap((c:any)=>visit(c,insideAsset||Boolean(kind)))};
  allocate=previousAllocate;
  if(kind && assetId){const tex=math?(el.attr('data-reader-tex')||el.find('[data-reader-tex]').first().attr('data-reader-tex')||el.find('annotation[encoding="application/x-tex"]').first().text()||el.find('.reader-math-source').text()||el.text()):undefined;
   return [{type:'asset',id:assetId,kind,element,...(tex?{tex,tag:el.find('.reader-equation__tag,.tag').first().text()||undefined,display:el.is('[data-reader-equation],.katex-display,.reader-math-source--block')||el.attr('data-reader-math-display')==='true'}:{})}];}
  return [element];
 };
 const doc:ArticleDocument={version:1,provenance,children:$.root().contents().toArray().flatMap(n=>visit(n))};
 if(!validArticleDocument(doc))throw new Error('正文结构转换失败，原有内容仍保留。');return doc;
}
parser.renderer.rules.reader_math=parser.renderer.rules.reader_math_block=(tokens,i)=>{
 const t=tokens[i],display=t.type==='reader_math_block'||Boolean(t.meta?.displayMode);
 try{return katex.renderToString(t.content,{displayMode:display,throwOnError:false,trust:false,strict:'ignore',maxSize:24,maxExpand:1000});}catch{return parser.utils.escapeHtml(t.content);}
};
export function articleDocumentFromMarkdown(text:string):ArticleDocument {return articleDocumentFromHtml(parser.render(text),'legacy');}
/** Original HTML is a derived presentation, not a second editable document. */
export function withArticleDocument(article:ReaderArticle):ReaderArticle {
 const document={...(article.document || articleDocumentFromHtml(article.contentHtml)),renderProfile:article.renderProfile,...(article.coverImageUrl?{cover:article.coverImageUrl}:{})};
 return {...article,document,importHtml:article.importHtml ?? article.contentHtml,contentHtml:articleDocumentHtml(document)};
}

export function articleDocumentMarkdown(doc:ArticleDocument):string {return rewriteText({entryId:"derived",url:"https://example.com/",title:"",renderProfile:"standard",contentHtml:articleDocumentHtml(doc)},false);}
