import { Fragment, type JSX, type ReactNode } from "react";
import { renderAiTeX, tokenizeAiMath } from "./ai-math";

/**
 * A deliberately small Markdown renderer for model answers. It recognises the
 * structures useful in study notes while keeping model HTML as inert text.
 * Mathematical delimiters are tokenised before emphasis, so TeX underscores
 * and asterisks can never be mistaken for Markdown formatting.
 */
export function AiMarkdownContent({ text }: { text: string }) {
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
  return <div className="ai-message-content ai-markdown">{blocks}</div>;
}

function startsBlock(lines: string[], index: number): boolean {
  if (index === 0) return false;
  const line = lines[index];
  return /^\s*```/.test(line)
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || Boolean(listKind(line))
    || /^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)
    || isTableDivider(lines[index + 1]);
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
      const rendered = renderAiTeX(segment.tex, segment.displayMode);
      if (rendered.html) {
        nodes.push(<span key={segmentKey} className={segment.displayMode ? "ai-math-display" : "ai-math-inline"} aria-label="数学公式" dangerouslySetInnerHTML={{ __html: rendered.html }} />);
      } else {
        nodes.push(<code key={segmentKey} className={segment.displayMode ? "ai-math-fallback ai-math-fallback--display" : "ai-math-fallback"}>{rendered.fallback || segment.tex}</code>);
      }
      return;
    }
    nodes.push(...renderMarkdownText(segment.value, segmentKey));
  });
  return nodes;
}

function renderMarkdownText(value: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`\n]+)`|(!?)\[([^\]]*)\]\(([^()\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const nodeKey = `${key}-${match.index}`;
    if (match[1] !== undefined) {
      nodes.push(<code className="ai-inline-code" key={nodeKey}>{match[1]}</code>);
    } else if (match[3] !== undefined) {
      const label = match[3] || "打开链接";
      const url = safeExternalUrl(match[4]);
      if (url) {
        nodes.push(<a className="ai-markdown-link" href={url} key={nodeKey} onClick={(event) => {
          event.preventDefault();
          void window.reader.openExternal(url).catch(() => undefined);
        }}>{match[2] === "!" ? `图片：${label}` : renderInline(label, `${nodeKey}-link`)}</a>);
      } else {
        nodes.push(match[0]);
      }
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(<strong key={nodeKey}>{renderInline(match[5] || match[6], `${nodeKey}-strong`)}</strong>);
    } else if (match[7] !== undefined) {
      nodes.push(<del key={nodeKey}>{renderInline(match[7], `${nodeKey}-delete`)}</del>);
    } else if (match[8] !== undefined || match[9] !== undefined) {
      nodes.push(<em key={nodeKey}>{renderInline(match[8] || match[9], `${nodeKey}-em`)}</em>);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
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
