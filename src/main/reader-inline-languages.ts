import type { load } from "cheerio";
import { readerLanguageFromTag, readerLanguageFromSwitchText, readerLanguageLabel } from "./reader-language-variants";
import type { ReaderLanguageVariant } from "../shared/types";

type Document = ReturnType<typeof load>;
/** An ephemeral selection, never a remote selector accepted over IPC. */
export interface InlineLanguages {
  variants: ReaderLanguageVariant[];
  activeLanguage: string;
  html: string;
}

/**
 * Recognize complete sibling translations, not foreign phrases in an article.
 * Standards (lang and ARIA tab associations) take precedence over explicit
 * language-container tokens used by static-site generators. No scripts run.
 */
export function selectInlineLanguages($: Document, pageUrl: string, requested?: string): InlineLanguages | undefined {
  const groups = new Map<any, Array<{ node: any; language: string; hidden: boolean }>>();
  $("article, main, [role='main'], .post-content, .article-content, .entry-content").find("div, section, article").each((_i, node) => {
    const element = $(node);
    if (element.closest("nav, aside, footer, pre, code, blockquote").length) return;
    const id = element.attr("id");
    const controls = id ? $("[role='tab'][aria-controls]").filter((_j, tab) => $(tab).attr("aria-controls") === id) : $([]);
    const language = readerLanguageFromTag(element.attr("lang") || element.attr("data-lang") || element.attr("data-language") || element.attr("data-locale"))
      || readerLanguageFromTag(controls.attr("lang") || controls.attr("data-lang"))
      || readerLanguageFromSwitchText(controls.text().trim())
      || languageToken(element.attr("class"), element.attr("id"));
    if (!language || element.text().trim().length < 160 || !element.find("p, h2, h3, ul, ol").length) return;
    const parent = element.parent().get(0);
    const group = groups.get(parent) || [];
    group.push({ node, language, hidden: element.is("[hidden], [aria-hidden='true']") || /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(element.attr("style") || "") });
    groups.set(parent, group);
  });
  const candidates = [...groups.values()].filter(group => group.length >= 2 && group.length <= 8
    && new Set(group.map(item => item.language)).size === group.length
    // Parallel translations must have explicit switching semantics or a hidden
    // alternative. Visible multilingual quotations alone aren't a version set.
    && (group.some(item => item.hidden) || $(group[0].node).parent().find("[role='tab'], [class*='lang-toggle'], [class*='language-switch']").length > 0));
  if (candidates.length !== 1) return undefined;
  const group = candidates[0];
  const selected = requested ? group.find(item => item.language === requested) : group.find(item => !item.hidden) || group[0];
  if (!selected) return undefined;
  return {
    activeLanguage: selected.language,
    html: $(selected.node).html() || "",
    variants: group.map(item => ({ url: pageUrl, language: item.language, label: readerLanguageLabel(item.language), inlineLanguage: item.language }))
  };
}

function languageToken(...values: Array<string | undefined>): string | undefined {
  for (const token of values.filter(Boolean).join(" ").split(/\s+/)) {
    const match = token.match(/^(?:lang(?:uage)?|translation)[-_](?:(?:body|content|panel)[-_])?([a-z]{2,3}(?:[-_][a-z]{2})?)$/i)
      || token.match(/^(?:body|content|panel)[-_]lang[-_]([a-z]{2,3}(?:[-_][a-z]{2})?)$/i);
    if (match) return readerLanguageFromTag(match[1]);
  }
  return undefined;
}
