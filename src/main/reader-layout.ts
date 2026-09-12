import type { load } from "cheerio";
type Document = ReturnType<typeof load>;

/** Linearize declared visual widgets and marginalia before removing origin CSS. */
export function normalizeReaderLayout($: Document, root: any, pageUrl: string): void {
  // A block labelled as one graphic is not a sequence of prose fragments.
  // Preserve actual images/videos and mathematical markup on their own paths.
  root.find("div[role='img'][aria-label], figure[role='img'][aria-label]").each((_i: number, node: any) => {
    if (!$(node).parents().toArray().includes(root.get(0))) return;
    let graphic = $(node);
    if (graphic.find("img, video, math, mjx-container, .katex, .MathJax").length) return;
    if (graphic.closest("math, mjx-container, [class*='MathJax'], .katex, [data-tex], [data-reader-tex]").length || graphic.find("script[type*='math'], [data-tex]").length) return;
    const description = (graphic.attr("aria-label") || "").trim();
    if (!description) return;
    const parent = graphic.parent();
    // Self-contained interactive widgets often put controls and a status bar
    // beside their labelled graphic. Never consume surrounding article prose.
    if (parent.is("div, figure") && parent.children("style").length && !parent.find("p, h1, h2, h3, h4, h5, h6, article, main, img, video, math, mjx-container, .katex").length) graphic = parent;
    const figure = $("<figure>");
    figure.append($("<p>").text(description));
    const caption = $("<figcaption>");
    caption.append($("<a>").attr("href", pageUrl).text("在原文中查看图示或交互"));
    figure.append(caption);
    graphic.replaceWith(figure);
  });

  const notes: any[] = [];
  root.find(".sidenote, .marginnote").each((_i: number, node: any) => {
    const note = $(node);
    const toggle = note.prevAll("input[type='checkbox'][id]").first();
    const id = toggle.attr("id");
    if (!id || !note.text().trim()) return;
    note.siblings("label").filter((_j: number, label: any) => $(label).attr("for") === id).remove();
    toggle.remove();
    note.find(".sidenote-number-copy").remove();
    const item = $("<li>").append(note.contents());
    notes.push(item);
    note.replaceWith($("<sup>").text(`[旁注 ${notes.length}]`));
  });
  if (notes.length) {
    const section = $("<section>").append($("<h2>").text("旁注"));
    const list = $("<ol>");
    for (const note of notes) list.append(note);
    root.append(section.append(list));
  }
}
