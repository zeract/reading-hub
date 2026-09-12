import { Fragment, memo, createContext, useContext, useEffect, useState, type JSX, type ReactNode } from "react";
import MarkdownIt from "markdown-it";
import { renderAiTeX, tokenizeAiMath } from "./ai-math";

/**
 * A deliberately small Markdown renderer for model answers. It recognises the
 * structures useful in study notes while keeping model HTML as inert text.
 * Mathematical delimiters are tokenised before emphasis, so TeX underscores
 * and asterisks can never be mistaken for Markdown formatting.
 */
// The input is immutable text. Reuse the rendered tree while a parent updates
// its draft, layout, provider state or a different streaming message.
export const AiMarkdownContent = memo(function AiMarkdownContent({ text, entryId }: { text: string; entryId?: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const language = fence[1];
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre className="ai-code-block" key={`code-${blocks.length}`}><code data-language={language || undefined}>{content.join("\n")}</code></pre>);
      continue;
    }

    const displayMath = displayMathBlockAt(lines, index);
    if (displayMath) {
      blocks.push(<div className="ai-math-block" key={`math-${blocks.length}`}>{renderMathSegment(displayMath.tex, true, `math-${blocks.length}`)}</div>);
      index = displayMath.nextIndex;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const Heading = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Heading className="ai-markdown-heading" key={`heading-${blocks.length}`}>{renderInline(heading[2], `heading-${blocks.length}`)}</Heading>);
      index += 1;
      continue;
    }

    if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(<hr className="ai-markdown-rule" key={`rule-${blocks.length}`} />);
      index += 1;
      continue;
    }

    if (isTableDivider(lines[index + 1])) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(tableCells(lines[index++]));
      blocks.push(<div className="ai-table-wrap" key={`table-${blocks.length}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, `th-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] || "", `td-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote className="ai-markdown-quote" key={`quote-${blocks.length}`}>{renderParagraphLines(quote, `quote-${blocks.length}`)}</blockquote>);
      continue;
    }

    const list = listKind(line);
    if (list) {
      const items: Array<{ text: string; checked?: boolean }> = [];
      const ordered = list.ordered;
      while (index < lines.length) {
        const item = listKind(lines[index]);
        if (!item || item.ordered !== ordered) break;
        const task = item.text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
        items.push(task ? { text: task[2], checked: task[1].toLowerCase() === "x" } : { text: item.text });
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List className="ai-markdown-list" key={`list-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly aria-label={item.checked ? "已完成" : "未完成"} />}{renderInline(item.text, `li-${itemIndex}`)}</li>)}</List>);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    if (paragraph.length) {
      blocks.push(<p className="ai-markdown-paragraph" key={`paragraph-${blocks.length}`}>{renderParagraphLines(paragraph, `paragraph-${blocks.length}`)}</p>);
    } else {
      index += 1;
    }
  }
  return <ImageEntry.Provider value={entryId}><div className="ai-message-content ai-markdown">{blocks}</div></ImageEntry.Provider>;
});

function startsBlock(lines: string[], index: number): boolean {
  if (index === 0) return false;
  const line = lines[index];
  return /^\s*```/.test(line)
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || Boolean(listKind(line))
    || /^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)
    || isTableDivider(lines[index + 1])
    || Boolean(displayMathBlockAt(lines, index));
}

type DisplayMathBlock = { tex: string; nextIndex: number };

/**
 * A model commonly writes a display delimiter on its own line. Parsing the
 * answer line-by-line used to split that one formula into ordinary text before
 * the TeX tokenizer could see its closing delimiter. Recognise only explicit,
 * paired display delimiters at a block boundary—never "formula-looking" text.
 */
function displayMathBlockAt(lines: string[], index: number): DisplayMathBlock | undefined {
  const source = lines.slice(index).join("\n");
  const opening = source.match(/^\s*(\\\[|\$\$|\\begin\{(align\*?|aligned|equation\*?|gather\*?|gathered|multline\*?|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\})/);
  if (!opening) return undefined;
  const marker = opening[1];
  const start = opening[0].length - marker.length;
  const close = marker === "\\["
    ? "\\]"
    : marker === "$$"
      ? "$$"
      : `\\end{${opening[2]}}`;
  const closeAt = source.indexOf(close, start + marker.length);
  if (closeAt < 0) return undefined;
  const end = closeAt + close.length;
  // A delimiter followed by prose on the same line is inline content and is
  // intentionally left to the inline parser.
  if (source.slice(end).split("\n", 1)[0].trim()) return undefined;
  const candidate = source.slice(start, end);
  const segments = tokenizeAiMath(candidate);
  if (segments.length !== 1 || segments[0].type !== "math" || !segments[0].displayMode) return undefined;
  return { tex: segments[0].tex, nextIndex: index + source.slice(0, end).split("\n").length };
}

function renderParagraphLines(lines: string[], key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    const hardBreak = / {2}$/.test(line);
    nodes.push(<Fragment key={`${key}-${index}`}>{renderInline(line.trimEnd(), `${key}-${index}`)}</Fragment>);
    if (index < lines.length - 1) nodes.push(hardBreak ? <br key={`${key}-break-${index}`} /> : " ");
  });
  return nodes;
}

function renderInline(value: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  tokenizeAiMath(value).forEach((segment, segmentIndex) => {
    const segmentKey = `${key}-math-${segmentIndex}`;
    if (segment.type === "math") {
      nodes.push(renderMathSegment(segment.tex, segment.displayMode, segmentKey));
      return;
    }
    nodes.push(...renderMarkdownText(segment.value, segmentKey));
  });
  return nodes;
}

function renderMathSegment(tex: string, displayMode: boolean, key: string): ReactNode {
  const rendered = renderAiTeX(tex, displayMode);
  if (rendered.html) {
    return <span key={key} className={displayMode ? "ai-math-display" : "ai-math-inline"} aria-label="数学公式" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
  }
  return <code key={key} className={displayMode ? "ai-math-fallback ai-math-fallback--display" : "ai-math-fallback"}>{rendered.fallback || tex}</code>;
}

const inlineMarkdown = new MarkdownIt({html:false, linkify:true});
const ImageEntry = createContext<string | undefined>(undefined);

/** Use CommonMark tokens for escaped/nested destinations; model HTML stays React text. */
function renderMarkdownText(value: string, key: string): ReactNode[] {
  const tokens = inlineMarkdown.parseInline(value, {})[0]?.children || [];
  let index = 0;
  function renderUntil(close?: string): ReactNode[] {
    const nodes: ReactNode[] = [];
    while (index < tokens.length) {
      const token = tokens[index++]; const nodeKey = `${key}-${index}`;
      if (token.type === close) break;
      if (token.type === "text" || token.type === "html_inline") nodes.push(token.content);
      else if (token.type === "code_inline") nodes.push(<code className="ai-inline-code" key={nodeKey}>{token.content}</code>);
      else if (token.type === "softbreak") nodes.push(" ");
      else if (token.type === "hardbreak") nodes.push(<br key={nodeKey}/>);
      else if (token.type === "link_open") {
        const children = renderUntil("link_close"); const url = safeExternalUrl(String(token.attrGet("href") || ""));
        nodes.push(url ? <MarkdownLink key={nodeKey} url={url}>{children}</MarkdownLink> : <Fragment key={nodeKey}>{children}</Fragment>);
      } else if (token.type === "image") {
        const url = safeExternalUrl(String(token.attrGet("src") || ""));
        nodes.push(url ? <MarkdownImage key={nodeKey} url={url} alt={token.content}/> : token.content);
      } else if (token.type === "strong_open") nodes.push(<strong key={nodeKey}>{renderUntil("strong_close")}</strong>);
      else if (token.type === "em_open") nodes.push(<em key={nodeKey}>{renderUntil("em_close")}</em>);
      else if (token.type === "s_open") nodes.push(<del key={nodeKey}>{renderUntil("s_close")}</del>);
      else if (token.content) nodes.push(token.content);
    }
    return nodes;
  }
  return renderUntil();
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
  const [image,setImage] = useState<{key:string;data?:string;failed?:boolean}>();
  const key = `${entryId}:${url}`;
  useEffect(()=>{
    if(!entryId || !url.startsWith("https://"))return;
    let active=true; const requestId=`image-${crypto.randomUUID()}`;
    void window.reader.loadArticleImage(entryId,url,requestId).then(data=>{if(active)setImage({key,data});}).catch(()=>{if(active)setImage({key,failed:true});});
    return ()=>{active=false;void window.reader.cancelArticleImage(requestId).catch(()=>undefined);};
  },[entryId,url,key]);
  if (!entryId) return <a className="ai-markdown-link" href={url} onClick={event=>{event.preventDefault();void window.reader.openExternal(url).catch(()=>undefined);}}>图片：{alt || "打开图片"}</a>;
  const openImage = () => { void window.reader.openExternal(url).catch(()=>undefined); };
  if (!url.startsWith("https://") || (image?.key===key && image.failed)) return <span className="reader-image-failure" role="link" tabIndex={0} onClick={event=>{event.preventDefault();event.stopPropagation();openImage();}} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();event.stopPropagation();openImage();}}}>图片未能加载 · {alt || "查看原图"}</span>;
  return <img src={image?.key===key?image.data:undefined} alt={alt} loading="lazy" onError={()=>setImage({key,failed:true})}/>;
}

function listKind(line: string): { ordered: boolean; text: string } | undefined {
  const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
  if (unordered) return { ordered: false, text: unordered[1] };
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  return ordered ? { ordered: true, text: ordered[1] } : undefined;
}

function isTableDivider(line: string | undefined): boolean {
  if (!line || !line.includes("|")) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
