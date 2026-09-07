import { load } from "cheerio";
import { Readability } from "@mozilla/readability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractReaderArticle } from "../src/main/article-reader";
import type { Entry } from "../src/shared/types";
const pageUrl = "https://example.com/posts/current.html";
const entry = { id: "fixture", url: pageUrl, title: "Fixture", sourceId: "fixture", createdAt: 1 } as Entry;
const prose = "A synthetic paragraph explains the document and its figures. ".repeat(12);
function document(base: string, extra = "") {
  return `<html lang="en"><head><title>Fixture</title>${base}<meta property="og:image" content="cover.png"><link rel="alternate" hreflang="zh" href="zh.html"></head><body><article><h1>Fixture</h1><p>${prose}</p><p><a href="appendix.html">Appendix</a></p><img src="figure.png"><img data-src="lazy.png"><p>${prose}</p>${extra}</article></body></html>`;
}
afterEach(() => vi.restoreAllMocks());

describe.each(["semantic", "combined"])("%s document base", (path) => {
  it("resolves article assets and alternatives without replacing the page identity", () => {
    if (path === "semantic") vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
    const result = extractReaderArticle(document('<base href="../assets/">'), pageUrl, entry)!.article;
    const $ = load(result.contentHtml);
    expect($("img").map((_, node) => $(node).attr("src")).get()).toEqual(["https://example.com/assets/figure.png", "https://example.com/assets/lazy.png"]);
    expect($("a").first().attr("href")).toBe("https://example.com/assets/appendix.html");
    expect(result.coverImageUrl).toBe("https://example.com/assets/cover.png");
    expect(result.languageVariants).toContainEqual(expect.objectContaining({ url: "https://example.com/assets/zh.html", language: "zh" }));
    expect(result.url).toBe(pageUrl);
    expect(result.activeLanguage).toBe("en");
    expect($("base, script, style")).toHaveLength(0);
  });
});

it("uses only the first base with href, including empty href", () => {
  vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
  for (const head of ['<base target="_blank"><base href="/first/"><base href="/second/">', '<base href=""><base href="/second/">']) {
    const result = extractReaderArticle(document(head), pageUrl, entry)!.article;
    const expected = head.includes('href=""') ? "https://example.com/posts/figure.png" : "https://example.com/first/figure.png";
    expect(load(result.contentHtml)("img").first().attr("src")).toBe(expected);
  }
});

it("ignores base elements in inert template contents", () => {
  const result = extractReaderArticle(document('<template><base href="/ignored/"></template><base href="/assets/">'), pageUrl, entry)!.article;
  expect(load(result.contentHtml)("img").first().attr("src")).toBe("https://example.com/assets/figure.png");
});

it("keeps cross-origin base assets while enforcing the actual page's language-link origin", () => {
  vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
  const result = extractReaderArticle(document('<base href="https://cdn.example/assets/">', '<a href="de.html" hreflang="de">Deutsch</a>'), pageUrl, entry)!.article;
  expect(load(result.contentHtml)("img").first().attr("src")).toBe("https://cdn.example/assets/figure.png");
  expect(result.languageVariants?.some((variant) => variant.language === "de")).toBe(false);
  expect(result.url).toBe(pageUrl);
});

it.each(["https://127.0.0.1/assets/", "https://user:pass@example.com/assets/", "file:///tmp/"])("rejects resolved resources from a disallowed base %s", (base) => {
  vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
  const result = extractReaderArticle(document(`<base href="${base}">`, '<img src="https://public.example/allowed.png">'), pageUrl, entry)!.article;
  const $ = load(result.contentHtml);
  expect($("img").map((_, node) => $(node).attr("src")).get()).toEqual(["https://public.example/allowed.png"]);
  expect(result.coverImageUrl).toBeUndefined();
  expect($("a[href]")).toHaveLength(0);
});

it.each(["javascript:alert(1)", "data:text/html,fixture", "http://["])("falls back for an invalid HTML base %s", (base) => {
  const result = extractReaderArticle(document(`<base href="${base}"><base href="/ignored/">`), pageUrl, entry)!.article;
  expect(load(result.contentHtml)("img").first().attr("src")).toBe("https://example.com/posts/figure.png");
});
