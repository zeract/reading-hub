import { articleDocumentHtml, validArticleDocument, type ArticleDocument, type ArticleNode, type ElementNode } from '../shared/article-document';

const escapeText = (text: string) => text.replace(/[\\`*_[\]<>#!|$~.+()-]/g, '\\$&');
const destination = (url: string) => `<${url.replace(/[<>\s]/g, c => encodeURIComponent(c))}>`;
const plain = (node: ArticleNode): string => node.type === 'text' ? node.text
  : node.type === 'element' ? node.children.map(plain).join('')
  : node.type === 'asset' ? plain(node.element) : node.title.map(plain).join('');
const fenceFor = (text: string) => '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));

/** Explicit export only. Walk semantic nodes; never re-extract the rendered HTML. */
export function articleDocumentMarkdown(document: ArticleDocument): string {
  if (!validArticleDocument(document)) throw new Error('正文结构格式无效，请检查应用版本。');
  const html = (node: ArticleNode) => articleDocumentHtml({ version: 1, provenance: document.provenance, children: [node] });
  const children = (node: ElementNode) => node.children.map(render).join('');
  function render(node: ArticleNode): string {
    if (node.type === 'text') return escapeText(node.text);
    if (node.type === 'card') return `\n\n[${node.title.map(render).join('').trim()}](${destination(node.url)})\n\n`;
    if (node.type === 'asset') {
      if (node.kind === 'math' && node.tex) {
        const tex = node.tag && !/\\tag\*?\s*\{/.test(node.tex) ? `${node.tex}\\tag{${node.tag}}` : node.tex;
        return node.display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
      }
      // Media attributes and authored code whitespace already belong to this node.
      return render(node.element);
    }
    if (node.tag === 'pre') {
      const code = plain(node), fence = fenceFor(code);
      return `\n\n${fence}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    if (node.tag === 'code' || node.tag === 'kbd') {
      const code = plain(node), fence = '`'.repeat(Math.max(1, ...Array.from(code.matchAll(/`+/g), m => m[0].length + 1)));
      const pad = /^`|`$|^ .* $/s.test(code) ? ' ' : '';
      return `${fence}${pad}${code}${pad}${fence}`;
    }
    const text = children(node);
    if (node.tag === 'img') return node.attrs.src ? `![${escapeText(node.attrs.alt || '')}](${destination(node.attrs.src)})` : '';
    if (node.tag === 'a') return node.attrs.href ? `[${text}](${destination(node.attrs.href)})` : text;
    if (/^h[1-6]$/.test(node.tag)) return `\n\n${'#'.repeat(Number(node.tag[1]))} ${text.trim()}\n\n`;
    if (node.tag === 'strong' || node.tag === 'b') return `**${text}**`;
    if (node.tag === 'em' || node.tag === 'i') return `*${text}*`;
    if (node.tag === 'del' || node.tag === 's') return `~~${text}~~`;
    if (node.tag === 'br') return '  \n';
    if (node.tag === 'hr') return '\n\n---\n\n';
    if (node.tag === 'blockquote') return `\n\n${text.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    if (node.tag === 'ul' || node.tag === 'ol') {
      let index = Number(node.attrs.start) || 1;
      return '\n\n' + node.children.map(item => {
        if (item.type !== 'element' || item.tag !== 'li') return render(item);
        const marker = node.tag === 'ol' ? `${index++}. ` : '- ';
        return children(item).trim().split('\n').map((line, i) => (i ? ' '.repeat(marker.length) : marker) + line).join('\n');
      }).join('\n') + '\n\n';
    }
    // GFM cannot represent row/column spans, arbitrary table headers, video,
    // MathML or SVG losslessly. Preserve their already validated semantic HTML.
    if (['table', 'video', 'math', 'svg', 'mjx-container', 'sub', 'sup', 'details', 'dl'].includes(node.tag)) return html(node);
    if (['p', 'div', 'figure', 'figcaption'].includes(node.tag)) return `\n\n${text.trim()}\n\n`;
    return text;
  }
  const cover = document.cover ? `![](${destination(document.cover)})\n\n` : '';
  return cover + document.children.map(render).join('').trim();
}
