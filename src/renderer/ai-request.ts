import {
  MAX_AI_ARTICLE_RAW_TEXT_LENGTH,
  MAX_AI_ARTICLE_TITLE_LENGTH,
  MAX_AI_SOURCE_TITLE_LENGTH,
  normaliseAiArticleMarkdown,
  normaliseAiArticleText,
  normaliseAiText
} from "../shared/ai-input";
import type { AiArticleContext } from "../shared/types";

/**
 * Builds the one bounded article context used by both the panel and the
 * selected-text helper. `plainText` must come from DOM textContent; the main
 * process repeats its own sanitisation before content can reach a provider.
 */
export function buildAiArticleContext(input: {
  title: string;
  url: string;
  sourceTitle?: string;
  plainText: string;
}): AiArticleContext {
  return {
    title: normaliseAiText(input.title, MAX_AI_ARTICLE_TITLE_LENGTH),
    url: input.url,
    sourceTitle: input.sourceTitle === undefined
      ? undefined
      : normaliseAiText(input.sourceTitle, MAX_AI_SOURCE_TITLE_LENGTH),
    text: normaliseAiArticleText(input.plainText)
  };
}

/**
 * Gather a bounded portion of DOM text before it is normalised for IPC. A
 * reader page may contain very large code samples or generated tables; the AI
 * context only needs a safe excerpt and must not construct their full text.
 */
export function collectAiArticleText(chunks: Iterable<string>): string {
  let remaining = MAX_AI_ARTICLE_RAW_TEXT_LENGTH;
  const collected: string[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const excerpt = chunk.slice(0, remaining);
    collected.push(excerpt);
    remaining -= excerpt.length;
  }
  return collected.join("");
}

/**
 * Converts the already-sanitised reader DOM into a bounded Markdown-shaped
 * excerpt for the explicit full-article translation task. It never returns
 * HTML, URLs, scripts, or DOM attributes. The regular AI Q&A path continues
 * to use plain text, so this richer representation cannot leak into a
 * selected-text translation request.
 */
export function serialiseArticleForTranslation(root: Element): string {
  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const chunks: string[] = [];
  let remaining = MAX_AI_ARTICLE_RAW_TEXT_LENGTH;
  const append = (value: string) => {
    if (!value || remaining <= 0) return;
    const excerpt = value.slice(0, remaining);
    chunks.push(excerpt);
    remaining -= excerpt.length;
  };
  const paragraph = (value: string) => {
    const content = value.trim();
    if (!content) return;
    append(content);
    append("\n\n");
  };
  const children = (node: Node): string => Array.from(node.childNodes).map(inline).join("");
  const formula = (element: Element): string | undefined => {
    const tex = element.getAttribute("data-reader-tex")
      || element.querySelector("annotation[encoding='application/x-tex']")?.textContent
      || (element.matches(".reader-math-source") ? element.textContent : undefined);
    const cleaned = tex?.replace(/\s+/g, " ").trim();
    return cleaned || undefined;
  };
  const isFormula = (element: Element): boolean => element.matches("[data-reader-equation], .reader-math-source, .katex, mjx-container");
  const inline = (node: Node): string => {
    if (node.nodeType === TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== ELEMENT_NODE) return "";
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (isFormula(element)) {
      const tex = formula(element);
      return tex ? `$${tex}$` : "[数学公式]";
    }
    if (tag === "br") return "\n";
    if (tag === "code") return `\`${(element.textContent || "").replace(/`/g, "\\`")}\``;
    if (tag === "strong" || tag === "b") return `**${children(element).trim()}**`;
    if (tag === "em" || tag === "i") return `*${children(element).trim()}*`;
    if (tag === "del" || tag === "s" || tag === "strike") return `~~${children(element).trim()}~~`;
    if (tag === "img") return element.getAttribute("alt")?.trim() ? `[图：${element.getAttribute("alt")?.trim()}]` : "[图]";
    return children(element);
  };
  const list = (element: Element, ordered: boolean) => {
    const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === "li");
    items.forEach((item, index) => paragraph(`${ordered ? `${index + 1}.` : "-"} ${children(item).replace(/\s*\n\s*/g, " ").trim()}`));
  };
  const table = (element: Element) => {
    const rows = Array.from(element.querySelectorAll("tr"))
      .map((row) => Array.from(row.children)
        .filter((cell) => /^(th|td)$/i.test(cell.tagName))
        .map((cell) => children(cell).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")))
      .filter((cells) => cells.length);
    if (!rows.length) return;
    const header = rows[0];
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...rows.slice(1).map((cells) => `| ${header.map((_cell, index) => cells[index] || "").join(" | ")} |`)
    ];
    paragraph(lines.join("\n"));
  };
  const visit = (node: Node): void => {
    if (remaining <= 0) return;
    if (node.nodeType === TEXT_NODE) {
      paragraph(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (isFormula(element)) {
      const tex = formula(element);
      paragraph(tex ? `$$\n${tex}\n$$` : "[数学公式]");
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      paragraph(`${"#".repeat(Number(tag[1]))} ${children(element).trim()}`);
      return;
    }
    if (tag === "p") { paragraph(children(element)); return; }
    if (tag === "pre") { paragraph(`\`\`\`\n${element.textContent || ""}\n\`\`\``); return; }
    if (tag === "blockquote") {
      const value = children(element).trim().split("\n").filter(Boolean).map((line) => `> ${line}`).join("\n");
      paragraph(value);
      return;
    }
    if (tag === "ul") { list(element, false); return; }
    if (tag === "ol") { list(element, true); return; }
    if (tag === "table") { table(element); return; }
    if (tag === "hr") { paragraph("---"); return; }
    if (tag === "figure") {
      Array.from(element.childNodes).forEach(visit);
      return;
    }
    if (tag === "figcaption") { paragraph(`*${children(element).trim()}*`); return; }
    const blockChildren = Array.from(element.children).some((child) => /^(article|aside|blockquote|details|div|figure|h[1-6]|li|ol|p|pre|section|table|ul)$/i.test(child.tagName));
    if (blockChildren) Array.from(element.childNodes).forEach(visit);
    else paragraph(children(element));
  };

  Array.from(root.childNodes).forEach(visit);
  return normaliseAiArticleMarkdown(chunks.join(""));
}
