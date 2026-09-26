import { expect, it } from "vitest";
import { load } from "cheerio";
import { extractReaderArticle } from "../src/main/article-reader";
import { readerLanguageChoices } from "../src/shared/reader-languages";
import type { Entry } from "../src/shared/types";
const url = "https://example.com/post";
const prose = `<p>${"Authored prose remains readable. ".repeat(25)}</p>`;
const extract = (body: string) => extractReaderArticle(`<article><h1>Fixture</h1>${prose}${body}</article>`, url, { id: "fixture", url, title: "Fixture" } as Entry)!.article;
it("keeps linked heading prose and formatting while removing permalink symbols", () => {
  const $ = load(extract('<h2 id="section"><a class="anchor" href="#section">Writing <em>memory</em></a></h2><h3>Next<a class="headerlink" href="#next">¶</a></h3>').contentHtml);
  expect($("h2").text()).toBe("Writing memory"); expect($("h2 em")).toHaveLength(1);
  expect($("h3").text()).toBe("Next"); expect($("h2 a,h3 a")).toHaveLength(0);
});
it("replaces a declared CSS diagram and its controls with its description without losing surrounding prose", () => {
  const a = extract(`<h2>Diagram</h2><div><style>.tile{display:flex}</style><button>play</button><div role="img" aria-label="Four memory sectors reach the controller."><span>warp</span><span>6 cyc</span><canvas></canvas></div><div>dirty 0/16</div></div><p>After the diagram.</p>`);
  expect(a.contentHtml).toContain("Four memory sectors reach the controller.");
  expect(a.contentHtml).toContain("After the diagram.");
  expect(a.contentHtml).toContain("在原文中查看图示或交互");
  expect(a.contentHtml).not.toMatch(/<canvas|<style|dirty 0\/16|warp|play/);
});
it("preserves real images in labelled graphic containers", () => {
  expect(load(extract('<div role="img" aria-label="Diagram"><img src="/diagram.png"></div>').contentHtml)("img")).toHaveLength(1);
});
it("keeps a safe reading fallback for Hugging Face-style embedded benchmark charts", () => {
  const articleUrl = "https://huggingface.co/blog/tokenizers-v1";
  const article = extractReaderArticle(`<article><h1>tokenizers v1</h1>${prose}<h2>Results</h2><iframe src="https://charts.static.hf.space/" width="100%" height="2615" title="Tokenizer benchmark charts"></iframe><p>What V1 Is</p></article>`, articleUrl, { id: "hf", url: articleUrl, title: "tokenizers v1" } as Entry)!.article;
  const $ = load(article.contentHtml);
  expect($("iframe,script")).toHaveLength(0);
  expect($("figure p").text()).toContain("Tokenizer benchmark charts");
  expect($("figure figcaption a").attr("href")).toBe(articleUrl);
  expect($("body").text()).toContain("What V1 Is");
});
it("reuses an existing figure around an embedded chart instead of nesting a second figure", () => {
  const $ = load(extract(`<figure class="image text-center"><iframe src="https://charts.static.hf.space/" width="100%" height="352"></iframe><figcaption>Encoding results</figcaption></figure>`).contentHtml);
  expect($("figure")).toHaveLength(1);
  expect($("figure p")).toHaveLength(1);
  expect($("figure figcaption").text()).toContain("Encoding results");
  expect($("figure figcaption a").attr("href")).toBe(url);
});
it("selects the authored blog body instead of the surrounding Hugging Face-style page shell", () => {
  const articleUrl = "https://huggingface.co/blog/example";
  const article = extractReaderArticle(`<main><div class="container"><div class="blog-content prose"><div class="mb-4"><a href="/blog">Back to Articles</a></div><h1>Example</h1><div>Published September 24, 2026</div><div class="not-prose">Upvote 20</div><div class="not-prose">Author avatars and follow controls</div><div class="relative overflow-clip">${prose}<h2>Results</h2><p>Benchmark details remain in the article.</p></div></div><section><h2>Models mentioned in this article</h2><article><p>Model recommendation card</p></article></section></div></main>`, articleUrl, { id: "hf-body", url: articleUrl, title: "Example" } as Entry)!.article;
  const text = load(article.contentHtml)("body").text();
  expect(text).toContain("Benchmark details remain in the article.");
  expect(text).not.toContain("Back to Articles");
  expect(text).not.toContain("Author avatars");
  expect(text).not.toContain("Upvote 20");
  expect(text).not.toContain("Models mentioned in this article");
  expect(text).not.toContain("Model recommendation card");
});
it("does not turn hidden, tiny or unsafe frames into reader content", () => {
  const $ = load(extract(`<iframe src="https://tracker.example/pixel" height="1" width="1"></iframe><iframe src="javascript:alert(1)" height="500"></iframe><iframe src="https://charts.example/view" height="300" hidden></iframe><iframe src="https://charts.example/hidden" height="300" style="display:none!important"></iframe><p>After frames.</p>`).contentHtml);
  expect($("figure,iframe")).toHaveLength(0);
  expect($("body").text()).toContain("After frames.");
});
it("moves checkbox-backed marginalia into numbered notes, preserving links and math", () => {
  const a = extract('<p>Before <span><input type="checkbox" id="note"><label for="note">1</label><span class="sidenote"><span class="sidenote-number-copy"></span>Note <a href="/reference">reference</a> $x^2$</span></span> after.</p>');
  const $ = load(a.contentHtml);
  expect($("sup").first().text()).toBe("[旁注 1]");
  expect($("h2").last().text()).toBe("旁注");
  expect($("ol li a").attr("href")).toBe("https://example.com/reference");
  expect($("ol li .katex")).toHaveLength(1);
  expect(a.contentHtml).not.toMatch(/☐|<input|<label/);
});
it("restricts language choices to one Chinese and one English, preferring the current version", () => {
  const choices = readerLanguageChoices([
    { url: "https://example.com/en-GB", language: "en", label: "English" },
    { url, language: "en", label: "English" },
    { url: "https://example.com/zh", language: "zh", label: "中文" },
    { url: "https://example.com/tw", language: "zh", label: "中文" },
    { url: "https://example.com/fr", language: "fr", label: "Français" },
    { url: "https://example.com/ja", language: "ja", label: "日本語" }
  ], url, "en");
  expect(choices.map(v => v.language)).toEqual(["en", "zh"]);
  expect(choices[0].url).toBe(url);
});
it("applies language policy to extraction without changing a non-English original", () => {
  const article = extractReaderArticle(`<html lang="fr"><head><link rel="alternate" hreflang="en" href="/en"><link rel="alternate" hreflang="ja" href="/ja"></head><body><article>${prose}</article></body></html>`, url, { id: "fixture", url, title: "Fixture" } as Entry)!.article;
  expect(article.activeLanguage).toBe("fr");
  expect(article.languageVariants?.map(v => v.language)).toEqual(["en"]);
});
