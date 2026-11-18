import { load } from "cheerio";
import { expect, it } from "vitest";
import { articleDocumentFromHtml } from "../src/main/article-document";
import { prepareSanitizedContent } from "../src/main/reader-extraction";
import { articleDocumentHtml } from "../src/shared/article-document";

const page = "https://example.com/cuda.html";
const lines = ["nvcc -O3 \\", "     add.cu # 注释", "", "curl https://example.com/cuda.html#cb2-4"];
const code = lines.join("\n");
const path = (index: number) => "#cb2-" + (index + 1);

function fixture(anchors: (index: number) => string): string {
  return '<pre><code class="language-bash">' + lines.map((line, index) =>
    "<span>" + anchors(index) + (line ? "<span>" + line + "</span>" : "") + "</span>"
  ).join("\n") + "</code></pre>";
}

it("keeps highlighted code and whitespace while removing empty code-line anchors", () => {
  const raw = fixture(index => '<a href="' + path(index) + '" aria-hidden="true" tabindex="-1"></a>')
    + '<p><a href="/details"></a></p><pre><code><a href="/real">authored label</a></code></pre>';
  const $ = load(prepareSanitizedContent(raw, page).html);
  expect($("pre code").first().text()).toBe(code);
  expect($("pre code").first().attr("class")).toBe("language-bash");
  expect($("pre code").first().find("a")).toHaveLength(0);
  expect($("p a").text()).toBe("https://example.com/details");
  expect($("pre code").last().find("a").text()).toBe("authored label");
});

const legacy = fixture(index => '<a href="' + page + path(index) + '">' + page + path(index) + "</a>");

it("repairs a saved code block only for display when the entire anchor sequence matches its page", () => {
  const document = articleDocumentFromHtml(legacy);
  const serialized = JSON.stringify(document);
  const $ = load(articleDocumentHtml(document, true, page + "#section"));
  expect($("code").text()).toBe(code);
  expect($("code a")).toHaveLength(0);
  expect(JSON.stringify(document)).toBe(serialized);
  expect(load(articleDocumentHtml(document, true, "https://example.com/other"))("code a")).toHaveLength(4);
});

it("preserves code links when the destination sequence or visible label disagrees", () => {
  for (const html of [legacy.replaceAll("#cb2-3", "#cb2-8"), legacy.replace('">' + page + '#cb2-1<', '">link label<')]) {
    const original = articleDocumentFromHtml(html);
    expect(articleDocumentHtml(original, true, page)).toBe(articleDocumentHtml(original, true));
  }
});
