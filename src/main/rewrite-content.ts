import { createHash } from "node:crypto";
import { createReaderMarkdown } from "../shared/markdown";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { normalizeRewriteCards } from "./rewrite-cards";
import { load } from "cheerio";
import type { ReaderArticle } from "../shared/types";
export const REWRITE_PROMPT_VERSION = 8;
const markdownLabel = (value:string) => value.replace(/[\\\[\]]/g, "\\$&").replace(/\s+/g," ");
const markdownDestination = (value:string) => value.replace(/[<>\s]/g,c=>encodeURIComponent(c));
const imageMarkdown = (url:string,alt:string) => `![${markdownLabel(alt || "图片")}](<${markdownDestination(url)}>)`;

/** Only declared image-to-full-size links count as aliases; never compare filenames or strip URL parameters. */
export function rewriteImageAliases(article:ReaderArticle): Array<{url:string;markdown:string}> {
 const $=load(article.contentHtml);const aliases:Array<{url:string;markdown:string}>=[];
 $("a[href] img[src]").each((_i,node)=>{
  const image=$(node),url=image.closest("a").attr("href"),src=image.attr("src");
  if(!url || !src?.startsWith("https://"))return;
  try {const target=new URL(url);if(target.protocol==="https:" && /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(target.pathname))aliases.push({url:target.href,markdown:imageMarkdown(src,image.attr("alt")||"图片")});}catch{/* An invalid declaration is not an alias. */}
 });
 return aliases;
}

export class RewriteContentError extends Error {
}
/** Use semantic source TeX once, not both rendered and accessibility copies. No network media. */
export function rewriteText(article: ReaderArticle): string {
    if (article.contentMode === "feed_summary")
        throw new RewriteContentError("当前只有订阅摘要，无法生成完整改写。请先在原文中确认正文可用。");
    const $ = load(`<main>${article.contentHtml}</main>`);
    normalizeRewriteCards($);
    const frozen: string[] = [];
    let prefix=`READER${createHash("sha256").update(article.contentHtml).digest("hex").slice(0,12)}ASSET`;
    while(article.contentHtml.includes(prefix))prefix+="X";
    const freeze = (value:string) => {const id=`${prefix}${frozen.length}END`;frozen.push(value);return id;};
    if (article.coverImageUrl && !$("main img").length) $("main").prepend($("<img>").attr("src",article.coverImageUrl));
    const mathSelector = "[data-reader-equation], .katex-display, .katex, mjx-container, [data-reader-tex], .reader-math-source";
    const formulas: Array<{node: ReturnType<typeof $>; tex:string; display:boolean; tag?:string}> = [];
    const labels = new Map<string,string>();
    $(mathSelector).each((_i, node) => {
        const el = $(node);
        if (el.parents(mathSelector).length || !el.parents("main").length) return;
        const tex = el.attr("data-reader-tex") || el.find("[data-reader-tex]").first().attr("data-reader-tex")
            || el.find('annotation[encoding="application/x-tex"]').first().text() || el.attr("data-tex")
            || (el.hasClass("reader-math-source") ? el.text() : el.find(".reader-math-source").first().text());
        if (!tex) return;
        const display = el.is("[data-reader-equation], .katex-display, [display='true'], .reader-math-source--block") || el.attr("data-reader-math-display") === "true";
        const printedTag = el.find(".reader-equation__tag, .tag").first().text().trim().replace(/^\((.*)\)$/s,"$1");
        const tag = printedTag || /\\tag\*?\{([^{}]*)\}/.exec(tex)?.[1];
        for (const match of tex.matchAll(/\\label\{([^}]+)\}/g)) if(tag) labels.set(match[1],tag);
        formulas.push({node:el,tex,display,tag});
    });
    const resolveReferences = (tex:string) => tex.replace(/\\(eqref|ref)\{([^}]+)\}/g, (original,kind,id) => {
        const number=labels.get(id);return number===undefined?original:kind==="eqref"?`(${number})`:number;
    });
    for (const {node,tex,display,tag} of formulas) {
        let content = resolveReferences(tex);
        if(display && tag && !/\\tag\*?\{/.test(content)) content += `\\tag{${tag.replace(/[{}]/g,"")}}`;
        node.replaceWith($(display ? "<div>" : "<span>").text(freeze(display ? `$$\n${content}\n$$` : `$${content}$`)));
    }
    $("script,style,button,input,video,source,.katex-html").remove();
    const converter = new TurndownService({headingStyle:"atx",codeBlockStyle:"fenced",bulletListMarker:"-",preformattedCode:true});
    converter.use(gfm);
    converter.addRule("readerStrike",{filter:node=>["DEL","S","STRIKE"].includes(node.nodeName),replacement:content=>`~~${content}~~`});
    converter.addRule("readerCell",{filter:["th","td"],replacement:(content,node)=>`${node.previousElementSibling ? " " : "| "}${content.trim().replace(/\n+/g," ").replace(/(?<!\\)\|/g,"\\|")} |`});
    // GFM requires a header row. An empty header preserves headerless data without
    // promoting the first data row to a heading or passing raw HTML to the model.
    $("table").each((_i,node)=>{
      const table=$(node),first=table.find("tr").first(),cells=first.children("th,td");
      if(!cells.length){table.remove();return;}
      if(!first.parent().is("thead")){
        const head=$("<thead>");
        if(cells.toArray().every(cell=>$(cell).is("th")))head.append(first);
        else {const row=$("<tr>");for(let i=0;i<cells.length;i++)row.append($("<th>"));head.append(row);}
        table.prepend(head);
      }
      const caption=table.children("caption");if(caption.length){table.before($("<p>").append(caption.contents()));caption.remove();}
    });
    converter.addRule("readerCaption",{filter:"figcaption",replacement:content=>`\n${content.trim()} `});
    converter.addRule("readerFigure",{filter:node=>node.nodeName==="FIGURE" && Boolean(node.querySelector("img")) && !node.querySelector("table,pre"),replacement:content=>`\n\n${content.trim().replace(/\n{2,}/g,"\n")}\n\n`});
    converter.addRule("readerImage", {filter:"img",replacement:(_content,node)=>{
        const src=node.getAttribute("src");
        return src?.startsWith("https://") ? freeze(imageMarkdown(src,node.getAttribute("alt") || "图片")) : "";
    }});
    converter.addRule("readerLink", {filter:"a",replacement:(content,node)=>{
        const href=node.getAttribute("href");
        // A full-resolution image link is a media action, not a second article link.
        if(node.querySelector("img") && !(node.textContent || "").trim())return content;
        return href && /^https?:\/\//.test(href) ? `[${content || markdownLabel(href)}](<${markdownDestination(href)}>)` : content;
    }});
    // Freeze source code before conversion so indentation, blank lines and fence characters survive.
    $("pre").each((_i,node)=>{
        const el=$(node),code=el.find("code").first();const value=code.length?code.text():el.text();
        const longest=Math.max(2,...(value.match(/`+/g)||[]).map(s=>s.length));const fence="`".repeat(longest+1);
        el.replaceWith($("<div>").text(freeze(`${fence}\n${value}\n${fence}`)));
    });
    $("code").each((_i,node)=>{const el=$(node),value=el.text();const fence="`".repeat(Math.max(0,...(value.match(/`+/g)||[]).map(s=>s.length))+1);el.replaceWith($("<span>").text(freeze(`${fence} ${value} ${fence}`)));});
    // Restore only our own placeholders, after the standard converter has serialized the structure.
    const text = converter.turndown($("main").html() || "").replace(new RegExp(prefix+"(\\d+)END","g"),(_m,n)=>frozen[Number(n)] ?? _m).trim();
    if (text.length < 80)
        throw new RewriteContentError("可读取的正文太短，无法生成可靠的中文改写。");
    if (text.length > 180000)
        throw new RewriteContentError("文章超过当前改写长度上限（18 万字符），请在原文中阅读。");
    return text;
}
/** Preserve complete paragraph/code/math blocks. Oversized blocks fail explicitly instead of silently truncating. */
export function splitRewriteText(text: string, limit = 9000, separateBlocks = false): string[] {
    const parser=createReaderMarkdown(),lines=text.split("\n"),blocks:string[]=[];
    for(const token of parser.parse(text,{})) {
        if(token.level!==0 || token.nesting===-1 || !token.map)continue;
        const block=lines.slice(token.map[0],token.map[1]).join("\n").trim();
        if(block.length>limit)throw new RewriteContentError("文章中有过长的连续段落、代码或公式，暂时无法安全分段改写。");
        if(block)blocks.push(block);
    }
    if(separateBlocks)return blocks;
    const chunks:string[]=[];let current="";
    for(const block of blocks){
        if(current && current.length+block.length+2>limit){chunks.push(current);current="";}
        current+=(current?"\n\n":"")+block;
    }
    if(current)chunks.push(current);
    return chunks;
}
