import {assertPublicUrl} from "./url";
/** Canonical local reading document. No raw HTML, script, or model-owned attributes. */
export type ArticleNode = TextNode | ElementNode | AssetNode | CardNode;
export interface TextNode { type:"text"; id:string; text:string }
export interface ElementNode { type:"element"; id:string; tag:string; attrs:Record<string,string>; children:ArticleNode[] }
export interface AssetNode { type:"asset"; id:string; kind:"math"|"code"|"image"|"video"; element:ElementNode; tex?:string; display?:boolean; tag?:string }
export interface CardNode { type:"card"; id:string; url:string; title:ArticleNode[]; metadata:ArticleNode[]; image?:string }
export interface ArticleDocument { version:1; cover?:string; renderProfile?:"standard"|"scientific"; provenance:"source"|"rewrite"|"legacy"; children:ArticleNode[] }
const tags=new Set('a abbr b blockquote br caption cite code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr img kbd li mark ol p picture pre s small span strong sub summary sup table tbody td th thead tfoot tr ul video button math semantics annotation mrow mi mo mn mfrac msup msub msubsup munder mover munderover mtext mspace mtable mtr mtd msqrt mroot menclose mpadded mstyle mphantom svg g path defs use rect line polyline polygon circle ellipse title mjx-container'.split(' '));
const attrs=new Set('href src alt title id class role tabindex aria-label aria-hidden loading start colspan rowspan open controls playsinline preload data-reader-zoomable data-reader-video-sources data-reader-video-load data-reader-tex data-reader-math-display data-reader-equation type encoding xmlns viewBox width height d x y x1 y1 x2 y2 cx cy r rx ry points transform fill stroke stroke-width preserveAspectRatio focusable display style data-mml-node data-mjx-texclass data-c data-id data-reader-math-source'.split(' '));
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function documentUrl(value:string):boolean {
 try{const u=assertPublicUrl(value);return ['https:','http:'].includes(u.protocol) && !u.username && !u.password;}catch{return /^#[\w:.-]+$/.test(value);}
}
export function safeDocumentAttribute(name:string,value:string):boolean {
 if(!attrs.has(name) || value.length>200000)return false;
 if(name==='src')return /^https?:\/\//.test(value) && documentUrl(value);
 if(name==='href')return documentUrl(value);
 if(name==='style')return !/url\s*\(|expression|@|javascript|\\|[<>]/i.test(value) && /^(?:[a-z-]+\s*:\s*[-+\w\s.,%()#]+;?\s*)*$/i.test(value);
 if(name==='data-reader-video-sources'){try{const v=JSON.parse(value);return Array.isArray(v)&&v.length<=4&&v.every(x=>typeof x==='string'&&x.startsWith('https://')&&documentUrl(x));}catch{return false;}}
 return true;
}
export function validArticleDocument(value:unknown):value is ArticleDocument {
 const doc=value as ArticleDocument; if(!doc || (doc.renderProfile!==undefined && !['standard','scientific'].includes(doc.renderProfile)) || (doc.cover!==undefined && (typeof doc.cover!=='string'||!/^https?:\/\//.test(doc.cover)||!documentUrl(doc.cover))) || doc.version!==1 || !['source','rewrite','legacy'].includes(doc.provenance) || !Array.isArray(doc.children))return false;
 let count=0,size=0;const ids=new Set<string>();
 const check=(n:ArticleNode,depth:number):boolean=>{
  if(!n || depth>100 || ++count>100000 || typeof n.id!=='string' || ids.has(n.id))return false;ids.add(n.id);
  if(n.type==='text'){if(typeof n.text!=='string')return false;size+=n.text.length;return size<=2000000;}
  if(n.type==='asset')return ['math','code','image','video'].includes(n.kind) && (n.tex===undefined || typeof n.tex==='string') && (n.display===undefined || typeof n.display==='boolean') && (n.tag===undefined || typeof n.tag==='string') && n.element?.type==='element' && check(n.element,depth+1);
  if(n.type==='card')return typeof n.url==='string' && documentUrl(n.url) && (n.image===undefined || typeof n.image==='string'&&/^https?:\/\//.test(n.image)&&documentUrl(n.image)) && Array.isArray(n.title)&&Array.isArray(n.metadata)&&[...n.title,...n.metadata].every(c=>check(c,depth+1));
  return n.type==='element' && tags.has(n.tag) && Boolean(n.attrs)&&typeof n.attrs==='object'&&!Array.isArray(n.attrs) && Object.entries(n.attrs).every(([k,v])=>typeof v==='string'&&safeDocumentAttribute(k,v)) && Array.isArray(n.children)&&n.children.every(c=>check(c,depth+1));
 };
 return doc.children.every(n=>check(n,0));
}
export function articleDocumentHtml(doc:ArticleDocument):string {
 if(!validArticleDocument(doc))throw new Error('正文结构格式无效，请检查应用版本。');
 const render=(n:ArticleNode):string=>{
  if(n.type==='text')return escape(n.text);
  if(n.type==='asset')return render(n.element);
  if(n.type==='card')return `<aside class="reader-link-card">${n.image?`<img src="${escape(n.image)}" loading="lazy" data-reader-zoomable="true" alt="">`:''}<div><a href="${escape(n.url)}">${n.title.map(render).join('')}</a>${n.metadata.length?`<div class="reader-link-card-meta">${n.metadata.map(render).join('')}</div>`:''}</div></aside>`;
  const attributes=Object.entries(n.attrs).map(([k,v])=>` ${k}="${escape(v)}"`).join('');
  return `<${n.tag}${attributes}>`+(['br','hr','img'].includes(n.tag)?'':n.children.map(render).join('')+`</${n.tag}>`);
 };
 return (doc.cover?`<img class="reader-cover" src="${escape(doc.cover)}" loading="lazy" data-reader-zoomable="true" tabindex="0" role="button" alt="">`:'')+doc.children.map(render).join('');
}
export function articleDocumentText(doc:ArticleDocument):string {
 const text=(n:ArticleNode):string=>n.type==='text'?n.text:n.type==='asset'?n.tex || (n.kind==='code'?text(n.element):''):n.type==='card'?[...n.title,...n.metadata].map(text).join(' '):n.children.map(text).join('')+(/^(p|h[1-6]|li|div|tr|blockquote)$/.test(n.tag)?'\n':'');
 return doc.children.map(text).join('\n').trim();
}
export function documentTextNodes(doc:ArticleDocument, includeEmpty=false):TextNode[] {
 const result:TextNode[]=[];
 const visit=(n:ArticleNode)=>{if(n.type==='text'){if(includeEmpty||n.text.trim())result.push(n);}else if(n.type==='element')n.children.forEach(visit);else if(n.type==='card')n.title.forEach(visit);};
 doc.children.forEach(visit);return result;
}
export const articleDocumentTags=tags;
