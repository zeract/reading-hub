import { load } from "cheerio";

export interface RewriteCard { url:string; title:string; labels:string[]; destinations:string[] }
const more = /^(?:read (?:full (?:story|article)|more)|continue reading|阅读全文|继续阅读|阅读更多)$/i;
const metadata = /^(?:[·•.\s]*)(?:(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)[·•.\s]*)?$/;
const headingSelector = "h1,h2,h3,h4,h5,h6";

/** Collapse a composed preview, never deduplicate links across the document. Works on sanitized DOM. */
export function normalizeRewriteCards($:ReturnType<typeof load>): RewriteCard[] {
  const cards:RewriteCard[]=[];
  $(headingSelector).each((_i,node)=>{
    const heading=$(node), link=heading.closest("a[href]"), url=link.attr("href"), title=heading.text().trim();
    if(!url?.startsWith("https://") || !title)return;
    let chosen:ReturnType<typeof $>|undefined;
    for(const parent of link.parents("div,aside,section,article,figure").toArray()) {
      const box=$(parent);
      // Do not absorb surrounding prose, another preview, a table or an authored list.
      if(box.find(headingSelector).length!==1 || box.find("p,pre,table,ul,ol,blockquote").length)break;
      const same=box.find("a[href]").filter((_j,a)=>$(a).attr("href")===url);
      const cover=same.find("img").length>0;
      const action=same.toArray().some(a=>more.test($(a).text().trim()));
      if(cover && action && same.length>=3){
        const remainder=box.clone();remainder.find("a,img,picture").remove();
        if(metadata.test(remainder.text().trim()))chosen=box;
      }
    }
    if(!chosen)return;
    const labels=chosen.find("a").toArray().map(a=>$(a).text().trim()).filter(Boolean);
    cards.push({url,title,labels:[...new Set(labels)],destinations:[...new Set(chosen.find("a[href]").toArray().map(a=>$(a).attr("href")!))]});
    chosen.replaceWith($("<p>").append($("<a>").attr("href",url).text(title)));
  });
  return cards;
}

export function rewriteCards(html:string):RewriteCard[] {return normalizeRewriteCards(load(html));}
