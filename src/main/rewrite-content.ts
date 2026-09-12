import { load } from "cheerio";
import type { ReaderArticle } from "../shared/types";
export const REWRITE_PROMPT_VERSION = 5;
export class RewriteContentError extends Error {
}
/** Use semantic source TeX once, not both rendered and accessibility copies. No network media. */
export function rewriteText(article: ReaderArticle): string {
    if (article.contentMode === "feed_summary")
        throw new RewriteContentError("当前只有订阅摘要，无法生成完整改写。请先在原文中确认正文可用。");
    const $ = load(`<main>${article.contentHtml}</main>`);
    if (article.coverImageUrl && !$("main img").length) $("main").prepend($("<img>").attr("src",article.coverImageUrl));
    $(".katex, mjx-container, [data-reader-tex], .reader-math-source").each((_i, node) => {
        const el = $(node);
        if (!el.parents("main").length)
            return;
        const tex = el.attr("data-reader-tex") || el.find('annotation[encoding="application/x-tex"]').first().text() || el.attr("data-tex") || (el.hasClass("reader-math-source") ? el.text() : undefined);
        if (tex)
            el.replaceWith($("<span>").text((el.attr("data-reader-math-display") === "true" || el.hasClass("reader-math-source--block") || el.closest(".katex-display, [data-reader-equation], mjx-container[display='true']").length) ? `\n$$\n${tex}\n$$\n` : `$${tex}$`));
    });
    $("script,style,button,input,video,source,.katex-html").remove();
    const label = (value: string) => value.replace(/[\\\[\]]/g, "\\$&").replace(/\s+/g, " ");
    const destination = (value: string) => value.replace(/[<>\s]/g, char => encodeURIComponent(char));
    $("img").each((_i, node) => {
        const el = $(node); const url = el.attr("src");
        el.replaceWith($("<span>").text(url?.startsWith("https://") ? `![${label(el.attr("alt") || "图片")}](<${destination(url)}>)` : ""));
    });
    $("a[href]").each((_i, node) => {
        const el = $(node); const href = el.attr("href")!;
        if (/^https?:\/\//.test(href)) {
            // Image-only links already retain their actual image destination.
            const text = el.text();
            el.replaceWith($("<span>").text(text.startsWith("![") ? text : `[${label(text || href)}](<${destination(href)}>)`));
        }
    });
    $("pre").each((_i, node) => { const el = $(node); el.replaceWith($("<div>").text(`\n\n\`\`\`\n${el.text()}\n\`\`\`\n\n`)); });
    $("p,div,section,h1,h2,h3,h4,h5,h6,li,blockquote,tr,figure,figcaption").append("\n\n");
    $("td,th").append(" | ");
    $("br").replaceWith("\n");
    const text = $("main").first().text().replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 80)
        throw new RewriteContentError("可读取的正文太短，无法生成可靠的中文改写。");
    if (text.length > 180000)
        throw new RewriteContentError("文章超过当前改写长度上限（18 万字符），请在原文中阅读。");
    return text;
}
/** Preserve complete paragraph/code/math blocks. Oversized blocks fail explicitly instead of silently truncating. */
export function splitRewriteText(text: string, limit = 9000, separateBlocks = false): string[] {
    const chunks: string[] = [];
    let current = "";
    let block = "";
    let fence = false;
    let math = false;
    const flushBlock = () => {
        if (!block.trim()) {
            block = "";
            return;
        }
        if (block.length > limit)
            throw new RewriteContentError("文章中有过长的连续段落、代码或公式，暂时无法安全分段改写。");
        if (separateBlocks) { chunks.push(block.trim()); block = ""; return; }
        if (current.length + block.length + 2 > limit) {
            chunks.push(current.trim());
            current = "";
        }
        current += `${block.trim()}\n\n`;
        block = "";
    };
    for (const line of text.split("\n")) {
        if (/^\s*```/.test(line))
            fence = !fence;
        if (!fence && /^\s*\$\$\s*$/.test(line))
            math = !math;
        block += `${line}\n`;
        if (!line.trim() && !fence && !math)
            flushBlock();
    }
    flushBlock();
    if (current.trim())
        chunks.push(current.trim());
    return chunks;
}
