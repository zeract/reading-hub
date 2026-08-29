import { compactText } from "../shared/text";
import { assertPublicUrl, canonicalizeUrl, toAbsoluteUrl } from "../shared/url";
import type { ReaderLanguageVariant } from "../shared/types";

const READER_LANGUAGE_LABELS: Record<string, string> = {
  ar: "العربية",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  ru: "Русский",
  und: "原文",
  zh: "中文"
};

const LANGUAGE_SWITCH_TEXT = /^(?:中文(?:版本)?|简体中文|繁體中文|繁体中文|chinese(?:\s+version)?|english(?:\s+version)?|英文(?:版本)?|日本語|日文(?:版本)?|japanese(?:\s+version)?|한국어|korean(?:\s+version)?|fran[çc]ais|french(?:\s+version)?|deutsch|german(?:\s+version)?|español|spanish(?:\s+version)?|portugu[êe]s|portuguese(?:\s+version)?|русский|russian(?:\s+version)?|العربية|arabic(?:\s+version)?)[\s→»>-]*$/i;

type CheerioApi = ReturnType<typeof import("cheerio").load>;

/**
 * Finds only author-declared native-language alternatives. URL shapes never
 * discover a translation: a page must expose hreflang/alternate metadata, or
 * a same-origin link whose label or local container explicitly says it is a
 * language switch. This keeps source-specific URL conventions out of the
 * reader while avoiding unrelated navigation links.
 */
export function discoverReaderLanguageVariants($: CheerioApi, pageUrl: string): ReaderLanguageVariant[] {
  if (isZhihuReaderUrl(pageUrl)) return [];
  const page = normaliseReaderVariantUrl(pageUrl, pageUrl);
  if (!page) return [];
  const variants = new Map<string, ReaderLanguageVariant>();
  const add = (url: string, language: string | undefined) => {
    if (!language) return;
    const key = canonicalizeUrl(url);
    if (!variants.has(key)) variants.set(key, { url, language, label: readerLanguageLabel(language) });
  };

  const declaredPageLanguage = readerLanguageFromTag($("html").attr("lang")) || readerLanguageFromTag($("body").attr("lang"));
  if (declaredPageLanguage) add(page, declaredPageLanguage);

  $("link[href], a[href]").each((_index: number, node: any) => {
    const element = $(node);
    const target = normaliseReaderVariantUrl(element.attr("href"), pageUrl);
    if (!target) return;
    const tagName = String(node.tagName || "").toLowerCase();
    const rel = (element.attr("rel") || "").toLowerCase();
    const hreflang = element.attr("hreflang");
    const language = readerLanguageFromTag(hreflang)
      || readerLanguageFromTag(element.attr("lang"))
      || readerLanguageFromText(readerLinkLabel(element));
    const standardAlternate = /(?:^|\s)alternate(?:\s|$)/.test(rel) || Boolean(hreflang);
    if (standardAlternate) {
      // A document-level alternate declaration can legitimately point to a
      // publisher's translation domain. A clickable link must stay on the
      // same origin: otherwise arbitrary article content could advertise an
      // unrelated off-site page as a language version.
      if (tagName !== "link" && !sameReaderOrigin(target, pageUrl)) return;
      add(target, language);
      return;
    }
    if (!language || !sameReaderOrigin(target, pageUrl)) return;
    const label = readerLinkLabel(element);
    if (!LANGUAGE_SWITCH_TEXT.test(label) || !hasArticleLanguageSwitchContext(element)) return;
    add(target, language);
  });

  // A URL token is used only to label the current page after the publisher
  // has already exposed a genuine alternate-language link. When a publisher
  // omits both it and html[lang], retain a neutral “original” entry so the
  // user can still reach the author-declared alternative without guessing
  // what language the original is written in.
  if (!declaredPageLanguage && variants.size > 0) add(page, readerLanguageFromUrl(pageUrl) || "und");
  return sortReaderLanguageVariants([...variants.values()], page);
}

/** Merge cached and freshly detected metadata, never article HTML. */
export function mergeReaderLanguageVariants(
  knownVariants: ReaderLanguageVariant[],
  discoveredVariants: ReaderLanguageVariant[],
  currentUrl: string,
  activeLanguage: string | undefined
): ReaderLanguageVariant[] {
  const merged = new Map<string, ReaderLanguageVariant>();
  for (const variant of [...knownVariants, ...discoveredVariants]) {
    const url = normaliseReaderVariantUrl(variant.url, currentUrl);
    const language = readerLanguageFromTag(variant.language);
    if (!url || !language) continue;
    const key = canonicalizeUrl(url);
    if (!merged.has(key)) merged.set(key, { url, language, label: readerLanguageLabel(language) });
  }
  const currentLanguage = readerLanguageFromTag(activeLanguage);
  const current = normaliseReaderVariantUrl(currentUrl, currentUrl);
  if (current && currentLanguage && !merged.has(canonicalizeUrl(current))) {
    merged.set(canonicalizeUrl(current), { url: current, language: currentLanguage, label: readerLanguageLabel(currentLanguage) });
  }
  return sortReaderLanguageVariants([...merged.values()], currentUrl);
}

export function sameCanonicalUrl(left: string, right: string): boolean {
  try {
    return canonicalizeUrl(left) === canonicalizeUrl(right);
  } catch {
    return false;
  }
}

function sortReaderLanguageVariants(variants: ReaderLanguageVariant[], currentUrl: string): ReaderLanguageVariant[] {
  return variants.sort((left, right) => {
    const leftCurrent = sameCanonicalUrl(left.url, currentUrl);
    const rightCurrent = sameCanonicalUrl(right.url, currentUrl);
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
    return left.label.localeCompare(right.label, "zh-CN");
  });
}

function normaliseReaderVariantUrl(value: string | undefined, pageUrl: string): string | undefined {
  const absolute = toAbsoluteUrl(value, pageUrl);
  if (!absolute) return undefined;
  try {
    const url = assertPublicUrl(absolute);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function readerLinkLabel(element: any): string {
  return compactText([
    element.text(),
    element.attr("aria-label"),
    element.attr("title")
  ].filter(Boolean).join(" "), 160) || "";
}

function hasArticleLanguageSwitchContext(element: any): boolean {
  // Visible text such as “中文版本” is a useful author signal only when it is
  // local to an article. A global site navigation often uses the same label
  // for a language homepage, not the translation of this individual post.
  if (element.closest("article, main, [role='main'], .post, .post-content, .article, .article-content, .entry-content").length > 0) return true;
  return hasLanguageSwitchSemantics(element);
}

function hasLanguageSwitchSemantics(element: any): boolean {
  const identity = [
    element.attr("class"),
    element.attr("id"),
    element.attr("data-lang"),
    element.attr("data-language"),
    element.attr("data-locale"),
    element.attr("aria-label"),
    element.parent()?.attr("class"),
    element.parent()?.attr("id")
  ].filter(Boolean).join(" ");
  if (!/(?:^|[\s_-])(?:lang(?:uage)?|locale|translation|translate|switch|version)(?:$|[\s_-])/i.test(identity)) return false;
  // A dedicated switch container is also article-local. This covers pages
  // that place versions beside the title without an `article`/`main` tag,
  // while rejecting a generic top-level language navigation.
  return element.closest("header, [role='banner'], nav").length === 0
    || element.closest("article, main, [role='main'], .post, .post-content, .article, .article-content, .entry-content").length > 0;
}

function readerLanguageFromTag(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || normalized === "x-default") return undefined;
  const primary = normalized.split("-", 1)[0];
  if (primary === "cn") return "zh";
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

function readerLanguageFromText(value: string): string | undefined {
  if (!value) return undefined;
  if (/(?:简体中文|繁體中文|繁体中文|中文|chinese)/i.test(value)) return "zh";
  if (/(?:english|英文)/i.test(value)) return "en";
  if (/(?:日本語|日文|japanese)/i.test(value)) return "ja";
  if (/(?:한국어|korean)/i.test(value)) return "ko";
  if (/(?:fran[çc]ais|french)/i.test(value)) return "fr";
  if (/(?:deutsch|german)/i.test(value)) return "de";
  if (/(?:español|spanish)/i.test(value)) return "es";
  if (/(?:portugu[êe]s|portuguese)/i.test(value)) return "pt";
  if (/(?:русский|russian)/i.test(value)) return "ru";
  if (/(?:العربية|arabic)/i.test(value)) return "ar";
  return undefined;
}

function readerLanguageFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const queryLanguage = readerLanguageFromTag(url.searchParams.get("lang") || url.searchParams.get("language") || url.searchParams.get("locale") || undefined);
    if (queryLanguage) return queryLanguage;
    const identity = decodeURIComponent(`${url.pathname}/${url.search}`).toLowerCase();
    const match = identity.match(/(?:^|[\/_\-.])(zh|cn|chinese|en|english|ja|japanese|ko|korean|fr|french|de|german|es|spanish|pt|portuguese|ru|russian|ar|arabic)(?=$|[\/_\-.?])/);
    if (!match) return undefined;
    return readerLanguageFromText(match[1]) || readerLanguageFromTag(match[1]);
  } catch {
    return undefined;
  }
}

function readerLanguageLabel(language: string): string {
  return READER_LANGUAGE_LABELS[language] || language.toUpperCase();
}

function sameReaderOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isZhihuReaderUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "zhihu.com" || host.endsWith(".zhihu.com");
  } catch {
    return false;
  }
}
