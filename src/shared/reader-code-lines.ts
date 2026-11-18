import type { ElementNode } from "./article-document";

/** Recognize the complete shape produced by the old sanitizer for Pandoc
 * line permalinks. Work on a display copy and leave uncertain blocks intact. */
export function withoutLegacyCodeLineLinks(block: ElementNode, page: string): ElementNode {
  const [code] = block.children;
  if (block.children.length !== 1 || code?.type !== "element" || code.tag !== "code") return block;
  const lines = code.children;
  const [first] = lines;
  const anchor = first?.type === "element" ? first.children[0] : undefined;
  const href = anchor?.type === "element" ? anchor.attrs.href : undefined;
  const prefix = href?.slice(page.length).match(/^#cb\d+-1$/)?.[0].slice(0, -1);
  if (!href?.startsWith(page) || !prefix || lines.length < 3) return block;

  const clean = [];
  let hasCode = false;
  for (const [index, line] of lines.entries()) {
    if (index % 2 === 1) {
      if (line.type !== "text" || line.text !== "\n") return block;
      clean.push(line);
      continue;
    }
    if (line.type !== "element" || line.tag !== "span" || Object.keys(line.attrs).length) return block;
    const [link, ...text] = line.children;
    const expected = page + prefix + (index / 2 + 1);
    if (link?.type !== "element" || link.tag !== "a" || link.attrs.href !== expected || Object.keys(link.attrs).length !== 1
        || link.children.length !== 1 || link.children[0].type !== "text" || link.children[0].text !== expected) return block;
    hasCode ||= text.length > 0;
    clean.push({ ...line, children: text });
  }
  return hasCode ? { ...block, children: [{ ...code, children: clean }] } : block;
}
