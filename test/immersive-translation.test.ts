import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE,
  batchImmersiveTranslationSegments,
  createImmersiveTranslationStreamParser,
  createImmersiveTranslationPlan,
  renderImmersiveTranslationHtml,
  translationSegmentsForBatch,
  type ImmersiveTranslationHtmlParser,
  type ImmersiveTranslationSegment
} from "../src/renderer/immersive-translation";

const parser: ImmersiveTranslationHtmlParser = {
  parseFromString(input: string, _type: "text/html"): Document {
    return new JSDOM(input).window.document as unknown as Document;
  }
};

describe("immersive inline translation segments", () => {
  it("annotates leaf-level prose in order while preserving the original sanitised DOM", () => {
    const plan = createImmersiveTranslationPlan(`
      <h2>Overview</h2>
      <p>Use <span data-reader-tex="x^2">old formula frame</span> carefully.</p>
      <p><span data-reader-equation="true">E = mc²</span></p>
      <pre><code>const ignored = true;</code></pre>
      <blockquote><p>Quoted paragraph.</p></blockquote>
      <ul>
        <li>Leaf item with <code>identifier</code>.</li>
        <li>Outer item<ul><li>Nested item.</li></ul></li>
      </ul>
      <p data-reader-translation-id="source-controlled">Final paragraph.</p>
    `, { parser });

    expect(plan.segments.map(({ kind, sourceText }) => ({ kind, sourceText }))).toEqual([
      { kind: "heading", sourceText: "Overview" },
      { kind: "paragraph", sourceText: "Use [公式] carefully." },
      { kind: "paragraph", sourceText: "Quoted paragraph." },
      { kind: "list-item", sourceText: "Leaf item with [代码]." },
      { kind: "list-item", sourceText: "Nested item." },
      { kind: "paragraph", sourceText: "Final paragraph." }
    ]);
    expect(plan.segments).toHaveLength(6);
    expect(plan.annotatedHtml).toContain('data-reader-tex="x^2"');
    expect(plan.annotatedHtml).toContain("const ignored = true;");
    expect(plan.annotatedHtml).not.toContain("source-controlled");
    expect(plan.annotatedHtml.match(new RegExp(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE, "g"))).toHaveLength(6);
    expect(plan.segments.every(({ html, id }) => html.includes(`${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${id}"`))).toBe(true);
    expect(plan.segments.map(({ sourceText }) => sourceText)).not.toContain("E = mc²");
    expect(plan.truncated).toBe(false);
  });

  it("uses deterministic ids and never treats formula, code, or hidden fragments as prose", () => {
    const content = `
      <p>Visible prose.</p>
      <div data-reader-equation="true">x^2</div>
      <p><span class="katex">y^2</span></p>
      <pre>const noTranslation = true;</pre>
      <p hidden>Hidden prose.</p>
      <p aria-hidden="true">Decorative prose.</p>
      <p>Another visible line.</p>
    `;
    const first = createImmersiveTranslationPlan(content, { parser });
    const second = createImmersiveTranslationPlan(content, { parser });
    const withAnEarlierBlock = createImmersiveTranslationPlan(`<p>New earlier block.</p>${content}`, { parser });

    expect(first.segments.map(({ id }) => id)).toEqual(second.segments.map(({ id }) => id));
    expect(first.segments.map(({ sourceText }) => sourceText)).toEqual(["Visible prose.", "Another visible line."]);
    expect(withAnEarlierBlock.segments.find(({ sourceText }) => sourceText === "Visible prose.")?.id)
      .toBe(first.segments.find(({ sourceText }) => sourceText === "Visible prose.")?.id);
    expect(first.annotatedHtml).not.toMatch(/data-reader-translation-id="[^"]+"[^>]*>x\^2/);
    expect(first.annotatedHtml).toContain("const noTranslation = true;");
  });

  it("does not let a formula-only nested block suppress surrounding prose", () => {
    const plan = createImmersiveTranslationPlan(`
      <ul><li>Keep this explanation.<p><span class="katex">x^2</span></p></li></ul>
    `, { parser });

    expect(plan.segments.map(({ kind, sourceText }) => ({ kind, sourceText }))).toEqual([
      { kind: "list-item", sourceText: "Keep this explanation. [公式]" }
    ]);
  });

  it("inserts only escaped plain-text translations directly after their original blocks", () => {
    const plan = createImmersiveTranslationPlan(`
      <p>Read <a href="https://example.com">this link</a>.</p>
      <ul><li>List item.</li></ul>
    `, { parser });
    const [paragraph, listItem] = plan.segments;
    const rendered = renderImmersiveTranslationHtml(plan, {
      [paragraph.id]: "阅读 <strong>此链接</strong>。",
      [listItem.id]: "列表项目。"
    }, { parser, targetLanguage: "zh" });
    const document = new JSDOM(rendered).window.document;
    const originalParagraph = document.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${paragraph.id}"]`)!;
    const paragraphTranslation = originalParagraph.nextElementSibling!;

    expect(originalParagraph.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(paragraphTranslation.getAttribute("data-reader-translation-for")).toBe(paragraph.id);
    expect(paragraphTranslation.getAttribute("lang")).toBe("zh");
    expect(paragraphTranslation.textContent).toBe("阅读 <strong>此链接</strong>。");
    expect(paragraphTranslation.querySelector("strong")).toBeNull();
    expect(document.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${listItem.id}"] .reader-immersive-translation`)?.textContent)
      .toBe("列表项目。");
    expect(new JSDOM(renderImmersiveTranslationHtml(plan, { [paragraph.id]: "一次" }, { parser })).window.document
      .querySelectorAll("[data-reader-translation-for]")).toHaveLength(1);
  });

  it("parses progressive protocol tags across stream chunks without accepting unknown ids", () => {
    const stream = createImmersiveTranslationStreamParser(["first", "second"], { parser });
    const initial = stream.push("prefix <rh-translation id=\"first\">第一</rh-trans");
    const middle = stream.push("lation><rh-translation id='second'>second <b>line</b>");
    const final = stream.push(" done</rh-translation><rh-translation id=\"unknown\">ignored</rh-translation>");

    expect(initial.translations.get("first")).toBe("第一");
    expect(initial.pendingIds).toEqual(new Set(["first"]));
    expect(middle.translations.get("first")).toBe("第一");
    expect(middle.translations.get("second")).toBe("second line");
    expect(middle.completeIds).toEqual(new Set(["first"]));
    expect(middle.pendingIds).toEqual(new Set(["second"]));
    expect(final.translations).toEqual(new Map([
      ["first", "第一"],
      ["second", "second line done"]
    ]));
    expect(final.completeIds).toEqual(new Set(["first", "second"]));
    expect(final.pendingIds).toEqual(new Set());
  });

  it("keeps every provider payload bounded and structured without exposing original HTML", () => {
    const segments: ImmersiveTranslationSegment[] = [
      { id: "one", kind: "paragraph", sourceText: "First short sentence.", html: "<p>First short sentence.</p>" },
      { id: "two", kind: "paragraph", sourceText: "Second short sentence.", html: "<p>Second short sentence.</p>" },
      { id: "three", kind: "paragraph", sourceText: "A deliberately much longer third segment.", html: "<p>A deliberately much longer third segment.</p>" }
    ];
    const batches = batchImmersiveTranslationSegments(segments, { maximumSegments: 2, maximumCharacters: 43 });

    expect(batches.map(({ characterCount, segments: batchSegments }) => ({
      characterCount,
      ids: batchSegments.map(({ id }) => id)
    }))).toEqual([
      { characterCount: 43, ids: ["one", "two"] },
      { characterCount: "A deliberately much longer third segment.".length, ids: ["three"] }
    ]);
    const requestSegments = translationSegmentsForBatch(batches[0]);
    expect(JSON.stringify(requestSegments)).not.toContain("<p>");
    expect(requestSegments).toEqual([
      { id: "one", text: "First short sentence." },
      { id: "two", text: "Second short sentence." }
    ]);
  });

  it("marks a bounded plan as truncated instead of partially annotating a later block", () => {
    const plan = createImmersiveTranslationPlan("<p>First.</p><p>Second.</p>", {
      parser,
      maximumCharacters: "First.".length
    });

    expect(plan.segments.map(({ sourceText }) => sourceText)).toEqual(["First."]);
    expect(plan.truncated).toBe(true);
    expect(plan.annotatedHtml.match(new RegExp(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE, "g"))).toHaveLength(1);
  });

  it("skips a paragraph that cannot satisfy the per-segment IPC bound", () => {
    const plan = createImmersiveTranslationPlan("<p>Too long.</p><p>Fits.</p>", {
      parser,
      maximumSegmentCharacters: "Fits.".length
    });

    expect(plan.segments.map(({ sourceText }) => sourceText)).toEqual(["Fits."]);
    expect(plan.truncated).toBe(true);
  });
});
