import { observeReaderImage, IMAGE_FAILURE_LABEL } from "./reader-image-loader";
import { Fragment, memo, createContext, useContext, useEffect, useState, useRef, createElement, type ReactNode } from "react";
import { createReaderMarkdown } from "../shared/markdown";
import { renderAiTeX } from "./ai-math";

const markdown=createReaderMarkdown();
const OriginalUrl=createContext<string|undefined>(undefined);
const ImageEntry=createContext<string|undefined>(undefined);
type Token=ReturnType<typeof markdown.parse>[number];
const classes:Record<string,string>={p:"ai-markdown-paragraph",blockquote:"ai-markdown-quote",ul:"ai-markdown-list",ol:"ai-markdown-list",h1:"ai-markdown-heading",h2:"ai-markdown-heading",h3:"ai-markdown-heading",h4:"ai-markdown-heading",h5:"ai-markdown-heading",h6:"ai-markdown-heading"};
const allowed=new Set(["p","blockquote","ul","ol","li","h1","h2","h3","h4","h5","h6","strong","em","s","table","thead","tbody","tr","th","td"]);

export const AiMarkdownContent=memo(function AiMarkdownContent({text,entryId,sourceUrl}:{text:string;entryId?:string;sourceUrl?:string}) {
  return <OriginalUrl.Provider value={sourceUrl}><ImageEntry.Provider value={entryId}><div className="ai-message-content ai-markdown">{renderTokens(markdown.parse(text,{}),"doc")}</div></ImageEntry.Provider></OriginalUrl.Provider>;
});

/** Only allowlisted token types become React elements; remote/model HTML is never executed. */
function renderTokens(tokens:Token[],key:string):ReactNode[] {
  let index=0;
  function children(close?:string):ReactNode[] {
    const nodes:ReactNode[]=[];
    while(index<tokens.length){
      const token=tokens[index++],nodeKey=`${key}-${index}`;
      if(token.type===close)break;
      if(token.type==="inline")nodes.push(...renderTokens(token.children || [],nodeKey));
      else if(token.type==="text" || token.type==="html_inline" || token.type==="html_block")nodes.push(token.content);
      else if(token.type==="reader_math" || token.type==="reader_math_block"){
        const math=renderMathSegment(token.content,token.block || Boolean(token.meta?.displayMode),nodeKey);
        nodes.push(token.block?<div className="ai-math-block" key={nodeKey}>{math}</div>:math);
      } else if(token.type==="fence" || token.type==="code_block")nodes.push(<pre className="ai-code-block" key={nodeKey}><code data-language={token.info.trim().split(/\s/)[0] || undefined}>{token.content.replace(/\n$/,"")}</code></pre>);
      else if(token.type==="code_inline")nodes.push(<code className="ai-inline-code" key={nodeKey}>{token.content}</code>);
      else if(token.type==="softbreak")nodes.push(" ");
      else if(token.type==="hardbreak")nodes.push(<br key={nodeKey}/>);
      else if(token.type==="hr")nodes.push(<hr className="ai-markdown-rule" key={nodeKey}/>);
      else if(token.type==="image"){
        const url=safeExternalUrl(String(token.attrGet("src") || ""));
        nodes.push(url?<MarkdownImage key={nodeKey} url={url} alt={token.content}/>:token.content);
      } else if(token.nesting===1){
        const closeType=token.type.replace(/_open$/,"_close");
        let checked:boolean|undefined;
        if(token.type==="list_item_open"){
          const inline=tokens[index]?.type==="paragraph_open"?tokens[index+1]:undefined;
          const first=inline?.type==="inline"?inline.children?.[0]:undefined;
          const task=first?.type==="text"?/^\[([ xX])\]\s+/.exec(first.content):null;
          if(task){checked=task[1].toLowerCase()==="x";first!.content=first!.content.slice(task[0].length);}
        }
        const content=children(closeType);
        if(checked!==undefined)content.unshift(<input key={`${nodeKey}-check`} type="checkbox" checked={checked} readOnly aria-label={checked?"已完成":"未完成"}/>);
        if(token.type==="link_open"){
          const url=safeExternalUrl(String(token.attrGet("href") || ""));
          nodes.push(url?<MarkdownLink key={nodeKey} url={url}>{content}</MarkdownLink>:<Fragment key={nodeKey}>{content}</Fragment>);
        } else if(token.hidden)nodes.push(...content);
        else if(allowed.has(token.tag)){
          const props:Record<string,unknown>={key:nodeKey};if(classes[token.tag])props.className=classes[token.tag];
          if(token.tag==="ol" && token.attrGet("start"))props.start=Number(token.attrGet("start"));
          const align=String(token.attrGet("style") || "");if((token.tag==="th" || token.tag==="td") && /^(text-align:)(left|right|center)$/.test(align || ""))props.style={textAlign:align!.split(":")[1]};
          const element=createElement(token.tag==="s"?"del":token.tag,props,...content);
          nodes.push(token.tag==="table"?<div className="ai-table-wrap" key={nodeKey}>{element}</div>:element);
        } else nodes.push(...content);
      }
    }
    return nodes;
  }
  return children();
}

function renderMathSegment(tex: string, displayMode: boolean, key: string): ReactNode {
  const rendered = renderAiTeX(tex, displayMode);
  if (rendered.html) {
    return <span key={key} className={displayMode ? "ai-math-display" : "ai-math-inline"} aria-label="数学公式" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
  }
  return <code key={key} className={displayMode ? "ai-math-fallback ai-math-fallback--display" : "ai-math-fallback"}>{rendered.fallback || tex}</code>;
}

function MarkdownLink({url, children}: {url: string; children: ReactNode[]}) {
  const entryId = useContext(ImageEntry);
  const label = children.every(child => typeof child === "string") ? children.join("") : undefined;
  const bare = label !== undefined && safeExternalUrl(label) === url;
  return <a className="ai-markdown-link" href={url} title={url} onClick={event => {
    event.preventDefault(); event.stopPropagation();
    void window.reader.openExternal(url).catch(() => undefined);
  }}>{entryId && bare ? "链接" : children}</a>;
}

function MarkdownImage({url,alt}:{url:string;alt:string}) {
  const entryId = useContext(ImageEntry);
  const sourceUrl=useContext(OriginalUrl);
  const element=useRef<HTMLImageElement>(null);
  const [image,setImage] = useState<{key:string;data?:string;failed?:string}>();
  const key = `${entryId}:${url}`;
  useEffect(()=>{
    if(!entryId || !url.startsWith("https://"))return;
    if(!element.current)return;
    return observeReaderImage(element.current,entryId,url,
      data=>setImage({key,data}),code=>setImage({key,failed:code}));
  },[entryId,url,key]);
  if (!entryId) return <a className="ai-markdown-link" href={url} onClick={event=>{event.preventDefault();void window.reader.openExternal(url).catch(()=>undefined);}}>图片：{alt || "打开图片"}</a>;
  const openImage = () => { void window.reader.openExternal(safeExternalUrl(sourceUrl || "") || url).catch(()=>undefined); };
  if (!url.startsWith("https://") || (image?.key===key && image.failed)) return <span className="reader-image-failure" role="link" tabIndex={0} onClick={event=>{event.preventDefault();event.stopPropagation();openImage();}} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();event.stopPropagation();openImage();}}} data-image-failure={image?.failed}>{IMAGE_FAILURE_LABEL}</span>;
  return <img ref={element} src={image?.key===key?image.data:undefined} alt={alt} loading="lazy" onError={()=>setImage({key,failed:"DECODE"})}/>;
}

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
