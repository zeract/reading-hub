import { rewriteLinkAt } from "./rewrite-assets";
import { isRewriteCardAction, type RewriteCard } from "./rewrite-cards";

const date=/^(?:\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,?\s+\d{4})?)$/i;
const separator=/^[·•.]$/;

/** Repair only adjacent fragments attributable to a source-proven preview. Never merge across prose. */
export function repairRewriteCards(markdown:string,cards:ReadonlyArray<RewriteCard>) {
  let offset=0;const parts=markdown.split(/\n\n/).map(text=>{const part={text,start:offset,end:offset+text.length};offset+=text.length+2;return part;});
  const edits:Array<{start:number;end:number;text:string}>=[];const repairs:Array<{url:string;fragments:number;links:number}>=[];
  for(const card of cards){
    function classify(text:string):{links:number;labels:string[];evidence:boolean}|undefined {
      let rest="",links=0,evidence=false;const labels:string[]=[];
      for(let i=0;i<text.length;){
        const link=rewriteLinkAt(text,i);
        if(link){
          if(link.image || !card.destinations.includes(link.destination))return;
          if(link.destination===card.url){links++;labels.push(link.label);if(isRewriteCardAction(link.label))evidence=true;}
          else evidence=true;
          i=link.end;
        } else rest+=text[i++];
      }
      rest=rest.replace(/\[图片说明[：:]([^\]]+)\]/g,(whole,title)=>title.trim()===card.title?(evidence=true,""):whole).trim();
      if(rest && !card.labels.includes(rest) && rest!==card.title && !isRewriteCardAction(rest) && !separator.test(rest) && !date.test(rest))return;
      return {links,labels,evidence:evidence || isRewriteCardAction(rest) || date.test(rest)};
    }
    for(let i=0;i<parts.length;i++){
      const first=classify(parts[i].text);if(!first?.links)continue;
      let end=i+1,count=first.links,evidence=first.evidence;const labels=[...first.labels];
      while(end<parts.length){const next=classify(parts[end].text);if(!next)break;count+=next.links;evidence ||= next.evidence;labels.push(...next.labels);end++;}
      if(!count || (count<2 && end===i+1) || !evidence)continue;
      const label=labels.find(s=>/[\u3400-\u9fff]/.test(s) && !/^(链接|来源)$/.test(s) && !isRewriteCardAction(s)) || card.title.replace(/[\\\[\]]/g,"\\$&");
      const edit={start:parts[i].start,end:parts[end-1].end,text:`[${label}](<${card.url.replace(/[<>\s]/g,c=>encodeURIComponent(c))}>)`};
      parts.splice(i,end-i,edit);edits.push(edit);
      repairs.push({url:card.url,fragments:end-i,links:count});
    }
  }
  return {markdown:parts.map(p=>p.text).join("\n\n"),repairs,edits};
}

/** Apply source ranges across old processing boundaries without duplicating a split preview. */
export function repairRewriteCardSections(sections:ReadonlyArray<string>,cards:ReadonlyArray<RewriteCard>) {
  const result=repairRewriteCards(sections.join("\n\n"),cards);let offset=0;
  const repaired=sections.map(section=>{
    const start=offset,end=start+section.length;offset=end+2;let cursor=start,text="";
    for(const edit of [...result.edits].sort((a,b)=>a.start-b.start)){
      if(edit.end<=start || edit.start>=end)continue;
      text+=section.slice(cursor-start,Math.max(cursor,edit.start)-start);
      if(edit.start>=start)text+=edit.text;
      cursor=Math.min(end,edit.end);
    }
    return (text+section.slice(cursor-start)).trim();
  });
  return {...result,sections:repaired,markdown:repaired.join("\n\n")};
}
