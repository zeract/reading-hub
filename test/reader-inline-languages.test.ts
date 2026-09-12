import { describe, expect, it, vi } from "vitest";
import { load } from "cheerio";
import { ArticleReader, extractReaderArticle } from "../src/main/article-reader";
import type { Entry } from "../src/shared/types";
import type { PublicHttpClient } from "../src/main/http";
const url = "https://publisher.example/post";
const entry = { id: "fixture", sourceId: "fixture", url, title: "Fixture", createdAt: 1 } as Entry;
const chinese = `<p>${"中文正文，保留自己的公式。".repeat(30)} $x^2$</p>`;
const english = `<p>${"English translation has its own formula. ".repeat(20)} $y^2$</p><script>alert(1)</script><img src="/figure.png" onerror="alert(1)">`;
function document(attributes = ['class="lang-body-zh"', 'class="lang-body-en" hidden'], controls = "") {
  return `<html lang="en"><body><article><h1>Fixture</h1>${controls}<div ${attributes[0]}>${chinese}</div><div ${attributes[1]}>${english}</div></article></body></html>`;
}
describe("publisher-declared inline article versions", () => {
  it.each([
    [undefined, ""],
    [['lang="zh-CN"', 'lang="en" hidden'], ""],
    [['data-language="zh"', 'data-language="en" style="display: none"'], ""],
    [['id="first" role="tabpanel"', 'id="second" role="tabpanel" hidden'], '<div role="tablist"><button role="tab" aria-controls="first">中文</button><button role="tab" aria-controls="second">English</button></div>'],
    [['class="translation-zh"', 'class="translation-en" aria-hidden="true"'], ""]
  ] as const)("selects one declared body before extraction and sanitizes both versions (%j)", (attrs, controls) => {
    const html = document(attrs ? [...attrs] : undefined, controls);
    for (const language of [undefined, "en", "zh"]) {
      const article = extractReaderArticle(html, url, entry, undefined, language)!.article;
      expect(article.activeLanguage).toBe(language || "zh");
      expect(article.languageVariants).toHaveLength(2);
      expect(article.languageVariants?.map(item => item.inlineLanguage).sort()).toEqual(["en", "zh"]);
      expect(article.contentHtml).toContain(language === "en" ? "English translation" : "中文正文");
      expect(article.contentHtml).not.toContain(language === "en" ? "中文正文" : "English translation");
      expect(load(article.contentHtml)(".katex")).toHaveLength(1);
      expect(article.contentHtml).not.toMatch(/<script|onerror|lang-body/);
    }
  });
  it("does not infer versions from visible foreign passages, code tabs or ambiguous groups", () => {
    for (const html of [document(['lang="zh"', 'lang="en"']), document(['id="first"', 'id="second" hidden'], '<button role="tab" aria-controls="first">Chinese cooking</button><button role="tab" aria-controls="second">English history</button>'), document() + document()]) {
      expect(extractReaderArticle(html, url, entry)?.article.languageVariants?.some(item => item.inlineLanguage)).toBe(false);
    }
  });
  it("authorizes the URL and body together, rediscovers on switch, and rejects removed translations", async () => {
    let html = document();
    const getText = vi.fn(async () => ({ url, text: html }));
    const reader = new ArticleReader({ getText } as unknown as PublicHttpClient, { render: async () => ({ url, html }) });
    await reader.read(entry);
    await expect(reader.readLanguageVariant(entry, undefined, url, { inlineLanguage: "en" })).resolves.toMatchObject({ activeLanguage: "en" });
    await expect(reader.readLanguageVariant(entry, undefined, url, { inlineLanguage: "zh" })).resolves.toMatchObject({ activeLanguage: "zh" });
    const calls = getText.mock.calls.length;
    await expect(reader.readLanguageVariant(entry, undefined, url, { inlineLanguage: "fr" })).rejects.toThrow("已过期或不可用");
    await expect(reader.readLanguageVariant(entry, undefined, "https://other.example/", { inlineLanguage: "en" })).rejects.toThrow("已过期或不可用");
    expect(getText).toHaveBeenCalledTimes(calls);
    html = `<article>${chinese}</article>`;
    await expect(reader.readLanguageVariant(entry, undefined, url, { inlineLanguage: "en" })).rejects.toThrow("同页语言版本已不可用");
  });
});
