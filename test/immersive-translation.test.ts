import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE,
  IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE,
  ImmersiveTranslationRunController,
  applyImmersiveTranslationPatches,
  batchImmersiveTranslationSegments,
  clearImmersiveTranslationCache,
  createImmersiveTranslationStreamParser,
  createImmersiveTranslationPlan,
  discardImmersiveTranslationSegments,
  dispatchImmersiveTranslationBatches,
  indexImmersiveTranslationSourceElements,
  missingCompletedImmersiveTranslationSegments,
  prioritiseImmersiveTranslationBatches,
  prioritiseImmersiveTranslationSegmentsForViewport,
  readImmersiveTranslationCache,
  renderImmersiveTranslationHtml,
  translationSegmentsForBatch,
  writeImmersiveTranslationCache,
  type ImmersiveTranslationHtmlParser,
  type ImmersiveTranslationSegment
} from "../src/renderer/immersive-translation";

const parser: ImmersiveTranslationHtmlParser = {
  parseFromString(input: string, _type: "text/html"): Document {
    return new JSDOM(input).window.document as unknown as Document;
  }
};

describe("immersive inline translation segments", () => {
  it("invalidates late events before an article or language switch can reuse their cache scope", () => {
    const runs = new ImmersiveTranslationRunController();
    const chineseRun = runs.begin();

    expect(runs.owns(chineseRun)).toBe(true);
    runs.invalidate(chineseRun);
    const englishRun = runs.begin();

    expect(runs.owns(chineseRun)).toBe(false);
    expect(runs.owns(englishRun)).toBe(true);
  });

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
    expect(plan.segments.every(({ id }) => plan.annotatedHtml.includes(`${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${id}"`))).toBe(true);
    expect(plan.segments.every((segment) => !("html" in segment))).toBe(true);
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

  it("patches a live reader DOM in place during streaming instead of replacing article nodes", () => {
    const plan = createImmersiveTranslationPlan(`
      <p>First paragraph.</p>
      <p>Second paragraph with <img src="https://example.com/figure.png" alt="figure" />.</p>
      <ul><li>List item.</li></ul>
    `, { parser });
    const document = new JSDOM(`<main>${plan.annotatedHtml}</main>`).window.document;
    const root = document.querySelector("main")!;
    const [first, second, listItem] = plan.segments;
    const originalFirst = root.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${first.id}"]`)!;
    const originalSecond = root.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${second.id}"]`)!;
    const originalImage = root.querySelector("img")!;

    applyImmersiveTranslationPatches(root, plan, new Map([[first.id, "第一段。"]]), { targetLanguage: "zh" });

    const firstResult = root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${first.id}"]`)!;
    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${first.id}"]`)).toBe(originalFirst);
    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${second.id}"]`)).toBe(originalSecond);
    expect(root.querySelector("img")).toBe(originalImage);
    expect(firstResult.previousElementSibling).toBe(originalFirst);
    expect(firstResult.textContent).toBe("第一段。");

    applyImmersiveTranslationPatches(root, plan, new Map([
      [first.id, "更新后的第一段。"],
      [second.id, "第二段。"],
      [listItem.id, "列表项。"]
    ]), { targetLanguage: "zh" });

    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${first.id}"]`)).toBe(firstResult);
    expect(firstResult.textContent).toBe("更新后的第一段。");
    expect(root.querySelectorAll(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}]`)).toHaveLength(3);
    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${listItem.id}"]`)?.parentElement)
      .toBe(root.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${listItem.id}"]`));

    applyImmersiveTranslationPatches(root, plan, new Map([[second.id, "第二段。"]]), { targetLanguage: "zh" });

    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${first.id}"]`)).toBeNull();
    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}="${first.id}"]`)).toBe(originalFirst);
    expect(root.querySelector("img")).toBe(originalImage);
  });

  it("patches only dirty indexed stream nodes without rescanning the reader body", () => {
    const plan = createImmersiveTranslationPlan("<p>First paragraph.</p><p>Second paragraph.</p>", { parser });
    const document = new JSDOM(`<main>${plan.annotatedHtml}</main>`).window.document;
    const root = document.querySelector("main")!;
    const [first, second] = plan.segments;
    const sourceElements = indexImmersiveTranslationSourceElements(root, plan);

    applyImmersiveTranslationPatches(root, plan, new Map([
      [first.id, "第一段。"],
      [second.id, "第二段。"]
    ]), { sourceElements, targetLanguage: "zh" });
    const firstResult = root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${first.id}"]`)!;
    const secondResult = root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${second.id}"]`)!;
    const scan = vi.spyOn(root, "querySelectorAll");

    applyImmersiveTranslationPatches(root, plan, new Map([
      [first.id, "更新后的第一段。"],
      [second.id, "不应重新写入第二段。"]
    ]), {
      sourceElements,
      changedIds: [first.id],
      targetLanguage: "zh"
    });

    expect(scan).not.toHaveBeenCalled();
    expect(firstResult.textContent).toBe("更新后的第一段。");
    expect(secondResult.textContent).toBe("第二段。");
  });

  it("removes a transient partial translation when its batch is incomplete", () => {
    const plan = createImmersiveTranslationPlan("<p>First paragraph.</p><p>Second paragraph.</p>", { parser });
    const document = new JSDOM(`<main>${plan.annotatedHtml}</main>`).window.document;
    const root = document.querySelector("main")!;
    const [first, second] = plan.segments;
    const translations = new Map([[first.id, "完整译文。"], [second.id, "半句"]]);
    const sourceElements = indexImmersiveTranslationSourceElements(root, plan);

    applyImmersiveTranslationPatches(root, plan, translations, { sourceElements, targetLanguage: "zh" });
    const changedIds = discardImmersiveTranslationSegments(translations, [second]);
    applyImmersiveTranslationPatches(root, plan, translations, {
      sourceElements,
      changedIds,
      targetLanguage: "zh"
    });

    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${first.id}"]`)?.textContent).toBe("完整译文。");
    expect(root.querySelector(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}="${second.id}"]`)).toBeNull();
  });

  it("parses progressive protocol tags across stream chunks without accepting unknown ids", () => {
    const stream = createImmersiveTranslationStreamParser(["first", "second"], { parser });
    const initial = stream.push("prefix <rh-translation id=\"first\">第一</rh-trans");

    expect(initial.translations.get("first")).toBe("第一");
    expect(initial.changedTranslations).toEqual(new Map([["first", "第一"]]));
    expect(initial.pendingIds).toEqual(new Set(["first"]));
    const middle = stream.push("lation><rh-translation id='second'>second <b>line</b>");

    expect(middle.translations.get("first")).toBe("第一");
    expect(middle.translations.get("second")).toBe("second line");
    expect(middle.changedTranslations).toEqual(new Map([["second", "second line"]]));
    expect(middle.translations).toBe(initial.translations);
    expect(middle.completeIds).toEqual(new Set(["first"]));
    expect(middle.pendingIds).toEqual(new Set(["second"]));
    const final = stream.push(" done</rh-translation><rh-translation id=\"unknown\">ignored</rh-translation>");

    expect(final.translations).toEqual(new Map([
      ["first", "第一"],
      ["second", "second line done"]
    ]));
    expect(final.changedTranslations).toEqual(new Map([["second", "second line done"]]));
    expect(final.completeIds).toEqual(new Set(["first", "second"]));
    expect(final.pendingIds).toEqual(new Set());
  });

  it("keeps streaming text parsing incremental across split markup, entities, and comparison signs", () => {
    const noDomParser = {
      parseFromString: () => { throw new Error("stream deltas must not allocate DOMParser documents"); }
    } satisfies ImmersiveTranslationHtmlParser;
    const stream = createImmersiveTranslationStreamParser(["line"], { parser: noDomParser });

    const partial = stream.push('<rh-translation id="line">A &am');
    expect(partial.translations.get("line")).toBe("A");
    expect(partial.changedTranslations).toEqual(new Map([["line", "A"]]));
    const final = stream.push('p; <b>bold</b> comparison x < y and x<y>z &copy;</rh-translation>');

    expect(final.translations.get("line")).toBe("A & bold comparison x < y and x<y>z ©");
    expect(final.changedTranslations).toEqual(new Map([["line", "A & bold comparison x < y and x<y>z ©"]]));
    expect(final.completeIds).toEqual(new Set(["line"]));
  });

  it("treats missing closed protocol blocks as incomplete rather than a successful batch", () => {
    const segments: ImmersiveTranslationSegment[] = [
      { id: "first", kind: "paragraph", sourceText: "First" },
      { id: "second", kind: "paragraph", sourceText: "Second" }
    ];
    const stream = createImmersiveTranslationStreamParser(segments.map((segment) => segment.id));
    const progress = stream.push('<rh-translation id="first">第一</rh-translation><rh-translation id="second">第');

    expect(missingCompletedImmersiveTranslationSegments(segments, progress).map((segment) => segment.id)).toEqual(["second"]);
  });

  it("keeps every provider payload bounded and structured without exposing original HTML", () => {
    const segments: ImmersiveTranslationSegment[] = [
      { id: "one", kind: "paragraph", sourceText: "First short sentence." },
      { id: "two", kind: "paragraph", sourceText: "Second short sentence." },
      { id: "three", kind: "paragraph", sourceText: "A deliberately much longer third segment." }
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

  it("bounds dense tables and lists before they can schedule unbounded provider work", () => {
    const html = Array.from({ length: 12 }, (_, index) => `<p>Line ${index}.</p>`).join("");
    const plan = createImmersiveTranslationPlan(html, {
      parser,
      maximumSegments: 3,
      maximumCandidates: 5
    });

    expect(plan.segments.map(({ sourceText }) => sourceText)).toEqual(["Line 0.", "Line 1.", "Line 2."]);
    expect(plan.truncated).toBe(true);
    expect(plan.annotatedHtml.match(new RegExp(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE, "g"))).toHaveLength(3);
  });

  it("skips a paragraph that cannot satisfy the per-segment IPC bound", () => {
    const plan = createImmersiveTranslationPlan("<p>Too long.</p><p>Fits.</p>", {
      parser,
      maximumSegmentCharacters: "Fits.".length
    });

    expect(plan.segments.map(({ sourceText }) => sourceText)).toEqual(["Fits."]);
    expect(plan.truncated).toBe(true);
  });

  it("reuses only exact completed segment translations from the in-memory cache", () => {
    clearImmersiveTranslationCache();
    const plan = createImmersiveTranslationPlan("<p>First.</p><p>Second.</p>", { parser });
    const [first, second] = plan.segments;
    writeImmersiveTranslationCache("v1:test", "zh", plan.segments, new Map([[first.id, "第一。"], [second.id, "第二。"]]), new Set([first.id]));

    expect(readImmersiveTranslationCache("v1:test", "zh", plan.segments)).toEqual(new Map([[first.id, "第一。"]]));
    expect(readImmersiveTranslationCache("v1:test", "en", plan.segments)).toEqual(new Map());
    expect(readImmersiveTranslationCache("v1:other", "zh", plan.segments)).toEqual(new Map());
    expect(readImmersiveTranslationCache("v1:test", "zh", [{ ...first, sourceText: "Changed." }])).toEqual(new Map());
  });

  it("bounds the ephemeral cache and evicts the least-recently-used translation first", () => {
    clearImmersiveTranslationCache();
    const initial = Array.from({ length: 1_200 }, (_, index) => ({
      id: `segment-${index}`,
      kind: "paragraph" as const,
      sourceText: `Source ${index}`,
    }));
    const translations = new Map(initial.map((segment) => [segment.id, `译文 ${segment.id}`]));

    writeImmersiveTranslationCache("v1:cache-bound", "zh", initial, translations);
    // Refresh the first entry. A timestamp-only implementation can treat this
    // as tied with the other entries and evict the wrong paragraph.
    expect(readImmersiveTranslationCache("v1:cache-bound", "zh", [initial[0]])).toEqual(new Map([[initial[0].id, `译文 ${initial[0].id}`]]));
    const extra = { id: "segment-extra", kind: "paragraph" as const, sourceText: "Source extra" };
    writeImmersiveTranslationCache("v1:cache-bound", "zh", [extra], new Map([[extra.id, "译文 extra"]]));

    const cached = readImmersiveTranslationCache("v1:cache-bound", "zh", [...initial, extra]);

    expect(cached.get(initial[0].id)).toBe(`译文 ${initial[0].id}`);
    expect(cached.has(initial[1].id)).toBe(false);
    expect(cached.get(extra.id)).toBe("译文 extra");
    expect(cached).toHaveLength(1_200);
    clearImmersiveTranslationCache();
  });

  it("does not retain an unexpectedly oversized provider response in the session cache", () => {
    clearImmersiveTranslationCache();
    const segment: ImmersiveTranslationSegment = {
      id: "oversized", kind: "paragraph", sourceText: "small source"
    };

    writeImmersiveTranslationCache("v1:cache-bound", "zh", [segment], new Map([[segment.id, "译".repeat(6_000)]]));

    expect(readImmersiveTranslationCache("v1:cache-bound", "zh", [segment])).toEqual(new Map());
    clearImmersiveTranslationCache();
  });

  it("uses a bounded reading window that avoids long output tails", () => {
    const segments = Array.from({ length: 9 }, (_, index) => ({ id: `p-${index}`, kind: "paragraph" as const, sourceText: "x".repeat(900) }));
    const batches = batchImmersiveTranslationSegments(segments);

    expect(batches.map((batch) => batch.segments.length)).toEqual([4, 4, 1]);
    expect(batches.every((batch) => batch.characterCount <= 3_600)).toBe(true);
  });

  it("prioritises the first visible prose blocks before larger background batches", () => {
    const segments: ImmersiveTranslationSegment[] = [
      { id: "one", kind: "paragraph", sourceText: "a".repeat(700) },
      { id: "two", kind: "paragraph", sourceText: "b".repeat(650) },
      { id: "three", kind: "paragraph", sourceText: "c".repeat(400) },
      { id: "four", kind: "paragraph", sourceText: "d".repeat(400) },
      { id: "five", kind: "paragraph", sourceText: "e".repeat(400) }
    ];

    const dispatch = prioritiseImmersiveTranslationBatches(segments, {
      background: { maximumSegments: 2, maximumCharacters: 900 }
    });

    expect(dispatch.foreground).toMatchObject({
      index: 0,
      characterCount: 700,
      segments: [{ id: "one" }]
    });
    expect(dispatch.background.map((batch) => ({
      index: batch.index,
      ids: batch.segments.map((segment) => segment.id),
      characterCount: batch.characterCount
    }))).toEqual([
      { index: 1, ids: ["two"], characterCount: 650 },
      { index: 2, ids: ["three", "four"], characterCount: 800 },
      { index: 3, ids: ["five"], characterCount: 400 }
    ]);
    expect([
      ...(dispatch.foreground?.segments || []),
      ...dispatch.background.flatMap((batch) => batch.segments)
    ].map((segment) => segment.id)).toEqual(segments.map((segment) => segment.id));
  });

  it("prioritises paragraphs nearest the current viewport while retaining source order for ties", () => {
    const segments: ImmersiveTranslationSegment[] = [
      { id: "top", kind: "paragraph", sourceText: "Top" },
      { id: "visible-one", kind: "paragraph", sourceText: "Visible one" },
      { id: "visible-two", kind: "paragraph", sourceText: "Visible two" },
      { id: "later", kind: "paragraph", sourceText: "Later" }
    ];
    const element = (top: number, bottom: number) => ({
      getBoundingClientRect: () => ({ top, bottom })
    }) as unknown as Element;
    const ordered = prioritiseImmersiveTranslationSegmentsForViewport(segments, new Map([
      ["top", element(10, 40)],
      ["visible-one", element(130, 180)],
      ["visible-two", element(190, 230)],
      ["later", element(500, 540)]
    ]), { top: 120, bottom: 260 });

    expect(ordered.map(({ id }) => id)).toEqual(["visible-one", "visible-two", "top", "later"]);
  });

  it("still dispatches one oversized first source block immediately without reordering later prose", () => {
    const segments: ImmersiveTranslationSegment[] = [
      { id: "long-first", kind: "paragraph", sourceText: "a".repeat(1_500) },
      { id: "later", kind: "paragraph", sourceText: "b".repeat(120) }
    ];

    const dispatch = prioritiseImmersiveTranslationBatches(segments);

    expect(dispatch.foreground).toMatchObject({
      index: 0,
      characterCount: 1_500,
      segments: [{ id: "long-first" }]
    });
    expect(dispatch.background).toHaveLength(1);
    expect(dispatch.background[0].segments.map((segment) => segment.id)).toEqual(["later"]);
  });

  it("fills the slot released by a fast foreground batch while the background still has work", async () => {
    const segments: ImmersiveTranslationSegment[] = ["foreground", "one", "two", "three"].map((id) => ({
      id,
      kind: "paragraph",
      sourceText: id,
    }));
    const dispatch = {
      foreground: { index: 0, segments: [segments[0]], characterCount: 10 },
      background: [
        { index: 1, segments: [segments[1]], characterCount: 3 },
        { index: 2, segments: [segments[2]], characterCount: 3 },
        { index: 3, segments: [segments[3]], characterCount: 5 }
      ]
    };
    const started: string[] = [];
    const resolvers = new Map<string, (ok: boolean) => void>();
    const run = (batch: ImmersiveTranslationBatch) => new Promise<boolean>((resolve) => {
      const id = batch.segments[0].id;
      started.push(id);
      resolvers.set(id, resolve);
    });

    const running = dispatchImmersiveTranslationBatches(dispatch, {
      concurrency: 2,
      runForeground: async (batch, onFirstTranslation) => {
        onFirstTranslation();
        return run(batch);
      },
      runBackground: run
    });
    await settleDispatch();
    expect(started).toEqual(["foreground", "one"]);

    resolvers.get("foreground")!(true);
    await settleDispatch();
    expect(started).toEqual(["foreground", "one", "two"]);

    resolvers.get("one")!(true);
    resolvers.get("two")!(true);
    await settleDispatch();
    expect(started).toContain("three");
    resolvers.get("three")!(true);
    await expect(running).resolves.toBe(true);
  });
});

async function settleDispatch(): Promise<void> {
  // A foreground result crosses the runner, scheduler, and worker promise
  // boundaries. Yield one event-loop turn rather than relying on a fragile
  // fixed number of microtasks.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
