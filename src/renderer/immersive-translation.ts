import { MAX_AI_ARTICLE_TEXT_LENGTH, normaliseAiText } from "../shared/ai-input";

/**
 * The reader renders remote HTML only after the main process has sanitised it.
 * This module deliberately does not sanitise or render that HTML again: it
 * finds prose-sized units inside the inert DOMParser document and annotates
 * only those units for the reader to pair with an ephemeral translation.
 */
export const IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE = "data-reader-translation-id";
export const IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE = "data-reader-translation-for";
/** Matches the current IPC contract; callers may opt into a larger reviewed bound. */
export const DEFAULT_IMMERSIVE_TRANSLATION_SEGMENT_CHARACTERS = 1_600;

const TRANSLATABLE_BLOCK_SELECTOR = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "blockquote", "figcaption", "dt", "dd", "summary", "td", "th"
].join(",");

const NON_TRANSLATABLE_SELECTOR = [
  "pre", "code", "kbd", "samp", "script", "style", "noscript", "template",
  "textarea", "input", "select", "option", "button", "svg", "math", "mjx-container",
  "[data-reader-equation]", "[data-reader-tex]", "[data-tex]", "[data-eeimg]",
  ".reader-equation", ".reader-math-source", ".katex", ".ztext-math", ".MathJax",
  "[class*='MathJax']", "[hidden]", "[aria-hidden='true']"
].join(",");

const FORMULA_SELECTOR = [
  "svg", "math", "mjx-container", "[data-reader-equation]", "[data-reader-tex]",
  "[data-tex]", "[data-eeimg]", ".reader-equation", ".reader-math-source", ".katex",
  ".ztext-math", ".MathJax", "[class*='MathJax']"
].join(",");

const FORMULA_PLACEHOLDER = "[公式]";
const CODE_PLACEHOLDER = "[代码]";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export type ImmersiveTranslationSegmentKind =
  | "heading"
  | "paragraph"
  | "list-item"
  | "quote"
  | "caption"
  | "definition"
  | "table-cell";

export interface ImmersiveTranslationSegment {
  /** Stable within an unchanged reader document and safe to place in a DOM attribute. */
  id: string;
  kind: ImmersiveTranslationSegmentKind;
  /**
   * Plain source prose for the translator. Formulae and code are represented
   * by inert placeholders, so model output cannot rewrite the reader's
   * rendered maths or executable-looking snippets.
   */
  sourceText: string;
  /** The original, already-sanitised semantic element after annotation. */
  html: string;
}

export interface ImmersiveTranslationPlan {
  /** Original reader HTML with only data-reader-translation-id attributes added. */
  annotatedHtml: string;
  segments: readonly ImmersiveTranslationSegment[];
  /** True only when the caller's explicit bounded plan omitted later blocks. */
  truncated: boolean;
}

/** A narrow structural type keeps the helper usable in browser tests without importing jsdom into the renderer. */
export interface ImmersiveTranslationHtmlParser {
  parseFromString(input: string, type: "text/html"): Document;
}

export interface ImmersiveTranslationPlanOptions {
  /** The default mirrors the existing maximum per explicit article-AI request. */
  maximumCharacters?: number;
  /**
   * A single segment must fit the main-process validation bound. Oversized
   * blocks are skipped and make the plan truncated instead of creating an IPC
   * request that can only fail after the user has already enabled translation.
   */
  maximumSegmentCharacters?: number;
  /** Test-only injection; production uses the browser's inert DOMParser. */
  parser?: ImmersiveTranslationHtmlParser;
}

export interface ImmersiveTranslationBatch {
  index: number;
  segments: readonly ImmersiveTranslationSegment[];
  characterCount: number;
}

export interface ImmersiveTranslationBatchOptions {
  /** Small batches surface the first translated paragraph without waiting for a whole article. */
  maximumSegments?: number;
  maximumCharacters?: number;
}

export interface ImmersiveTranslationRenderOptions {
  /** A language hint lets assistive technology announce the translated line correctly. */
  targetLanguage?: "zh" | "en";
  /** Test-only injection; production uses the browser's inert DOMParser. */
  parser?: ImmersiveTranslationHtmlParser;
}

export interface ImmersiveTranslationProgress {
  /** Latest safe plain-text translation for each recognised segment id. */
  translations: ReadonlyMap<string, string>;
  /** IDs still receiving text because their closing protocol tag has not arrived. */
  pendingIds: ReadonlySet<string>;
  /** IDs whose closing protocol tag has arrived. */
  completeIds: ReadonlySet<string>;
}

export interface ImmersiveTranslationStreamParser {
  /** Feed only the newly streamed delta. The latest text is returned for every recognised id. */
  push(delta: string): ImmersiveTranslationProgress;
  /** Discards the previous provider response before a retry or a new article. */
  reset(): void;
}

/**
 * Marks leaf-level prose blocks in a sanitised article. Parent candidates that
 * contain another eligible prose block are skipped, preventing a list item,
 * its nested paragraph, and its nested list from being translated twice.
 */
export function createImmersiveTranslationPlan(
  contentHtml: string,
  options: ImmersiveTranslationPlanOptions = {}
): ImmersiveTranslationPlan {
  const parser = options.parser || new DOMParser();
  const document = parser.parseFromString(contentHtml, "text/html");
  const maximumCharacters = boundedPositiveInteger(options.maximumCharacters, MAX_AI_ARTICLE_TEXT_LENGTH);
  const maximumSegmentCharacters = boundedPositiveInteger(
    options.maximumSegmentCharacters,
    DEFAULT_IMMERSIVE_TRANSLATION_SEGMENT_CHARACTERS
  );
  const body = document.body;

  // Never trust a stale or source-provided annotation as a translation target.
  for (const element of Array.from(body.querySelectorAll(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}]`))) {
    element.removeAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE);
  }

  const candidates = Array.from(body.querySelectorAll<HTMLElement>(TRANSLATABLE_BLOCK_SELECTOR))
    .filter((element) => !isWithinNonTranslatableContent(element));
  // Work out viable source text before looking for nested candidates. A
  // formula-only child must not suppress a useful parent list item or quote.
  const candidateSourceText = new Map(
    candidates
      .map((element) => [element, sourceTextForTranslation(element)] as const)
      .filter(([, sourceText]) => hasTranslatableProse(sourceText))
  );
  const candidateSet = new Set(candidateSourceText.keys());
  const segments: ImmersiveTranslationSegment[] = [];
  const duplicateOccurrences = new Map<string, number>();
  let usedCharacters = 0;
  let truncated = false;

  for (const element of candidates) {
    if (hasEligibleCandidateDescendant(element, candidateSet)) continue;
    const sourceText = candidateSourceText.get(element);
    if (!sourceText) continue;
    if (sourceText.length > maximumSegmentCharacters) {
      truncated = true;
      continue;
    }
    if (usedCharacters + sourceText.length > maximumCharacters) {
      truncated = true;
      break;
    }

    const kind = segmentKind(element);
    const fingerprint = `${kind}:${fnv1a(sourceText)}`;
    const occurrence = (duplicateOccurrences.get(fingerprint) || 0) + 1;
    duplicateOccurrences.set(fingerprint, occurrence);
    const id = stableSegmentId(kind, sourceText, occurrence);
    element.setAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE, id);
    segments.push({ id, kind, sourceText, html: element.outerHTML });
    usedCharacters += sourceText.length;
  }

  return { annotatedHtml: body.innerHTML, segments, truncated };
}

/**
 * Preserves source order while keeping a provider request deliberately small.
 * A single long paragraph is never split across requests; it becomes its own
 * batch so its translation can still be inserted immediately beneath it.
 */
export function batchImmersiveTranslationSegments(
  segments: readonly ImmersiveTranslationSegment[],
  options: ImmersiveTranslationBatchOptions = {}
): ImmersiveTranslationBatch[] {
  const maximumSegments = boundedPositiveInteger(options.maximumSegments, 4);
  const maximumCharacters = boundedPositiveInteger(options.maximumCharacters, 2_400);
  const batches: ImmersiveTranslationBatch[] = [];
  let current: ImmersiveTranslationSegment[] = [];
  let characterCount = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push({ index: batches.length, segments: current, characterCount });
    current = [];
    characterCount = 0;
  };

  for (const segment of segments) {
    const exceedsBatch = current.length > 0 && (
      current.length >= maximumSegments || characterCount + segment.sourceText.length > maximumCharacters
    );
    if (exceedsBatch) flush();
    current.push(segment);
    characterCount += segment.sourceText.length;
  }
  flush();
  return batches;
}

/**
 * The only batch representation intended to cross renderer IPC. It excludes
 * original block HTML, URLs, attributes and translation-plan bookkeeping.
 */
export function translationSegmentsForBatch(batch: ImmersiveTranslationBatch): Array<{ id: string; text: string }> {
  return batch.segments.map(({ id, sourceText }) => ({ id, text: sourceText }));
}

/**
 * Rebuilds the annotated, already-sanitised reader HTML with each available
 * translation directly beneath its original block. `textContent`, rather than
 * innerHTML, is the only path for model output, so Markdown/HTML in a model
 * response stays literal text and cannot create active DOM.
 */
export function renderImmersiveTranslationHtml(
  plan: ImmersiveTranslationPlan,
  translations: ReadonlyMap<string, string> | Readonly<Record<string, string | undefined>>,
  options: ImmersiveTranslationRenderOptions = {}
): string {
  const parser = options.parser || new DOMParser();
  const document = parser.parseFromString(plan.annotatedHtml, "text/html");
  const allowedIds = new Set(plan.segments.map(({ id }) => id));

  // Idempotence matters while stream events progressively update a batch.
  for (const result of Array.from(document.querySelectorAll(`[${IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE}]`))) result.remove();

  for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}]`))) {
    const id = element.getAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE);
    if (!id || !allowedIds.has(id)) {
      element.removeAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE);
      continue;
    }
    const translation = translationForId(translations, id);
    if (!translation) continue;

    const result = document.createElement(inlineTranslationContainer(element) ? "span" : "div");
    result.className = "reader-immersive-translation";
    result.setAttribute(IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE, id);
    result.setAttribute("dir", "auto");
    if (options.targetLanguage) result.setAttribute("lang", options.targetLanguage);
    result.textContent = plainTranslationText(translation);
    if (!result.textContent) continue;

    if (inlineTranslationContainer(element)) element.append(result);
    else element.insertAdjacentElement("afterend", result);
  }

  return document.body.innerHTML;
}

/**
 * Parses streamed protocol tags across arbitrary IPC chunk boundaries. It is
 * intentionally tolerant of a missing final close tag so the first translated
 * paragraph can render while the provider is still producing the rest.
 */
export function createImmersiveTranslationStreamParser(
  allowedSegmentIds: Iterable<string>,
  options: Pick<ImmersiveTranslationRenderOptions, "parser"> = {}
): ImmersiveTranslationStreamParser {
  const allowedIds = new Set(allowedSegmentIds);
  let source = "";

  return {
    push(delta: string): ImmersiveTranslationProgress {
      source += delta;
      return parseImmersiveTranslationProgress(source, allowedIds, options.parser);
    },
    reset(): void {
      source = "";
    }
  };
}

function isWithinNonTranslatableContent(element: Element): boolean {
  return element.matches(NON_TRANSLATABLE_SELECTOR) || Boolean(element.parentElement?.closest(NON_TRANSLATABLE_SELECTOR));
}

function hasEligibleCandidateDescendant(element: Element, candidates: ReadonlySet<Element>): boolean {
  return Array.from(element.querySelectorAll(TRANSLATABLE_BLOCK_SELECTOR))
    .some((descendant) => candidates.has(descendant));
}

function sourceTextForTranslation(element: Element): string {
  const chunks: string[] = [];
  const append = (value: string) => {
    if (value) chunks.push(value);
  };
  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      append(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const child = node as Element;
    if (child.matches(FORMULA_SELECTOR)) {
      append(` ${FORMULA_PLACEHOLDER} `);
      return;
    }
    if (child.matches("pre, code, kbd, samp")) {
      append(` ${CODE_PLACEHOLDER} `);
      return;
    }
    if (child.matches("script, style, noscript, template, textarea, input, select, option, button, [hidden], [aria-hidden='true']")) return;
    if (child.tagName.toLowerCase() === "br") {
      append(" ");
      return;
    }
    for (const grandchild of Array.from(child.childNodes)) visit(grandchild);
  };

  for (const child of Array.from(element.childNodes)) visit(child);
  return normaliseAiText(chunks.join(""), MAX_AI_ARTICLE_TEXT_LENGTH)
    // Placeholder nodes are intentionally padded while collecting adjacent
    // DOM text. Remove only punctuation-adjacent padding afterwards so source
    // prose stays natural without joining ordinary words across markup.
    .replace(/\s+([,.;:!?，。；：！？、\)\]）】])/g, "$1");
}

function hasTranslatableProse(sourceText: string): boolean {
  return sourceText
    .replaceAll(FORMULA_PLACEHOLDER, "")
    .replaceAll(CODE_PLACEHOLDER, "")
    .trim()
    .length > 0;
}

function translationForId(
  translations: ReadonlyMap<string, string> | Readonly<Record<string, string | undefined>>,
  id: string
): string | undefined {
  return isTranslationMap(translations) ? translations.get(id) : translations[id];
}

function isTranslationMap(
  translations: ReadonlyMap<string, string> | Readonly<Record<string, string | undefined>>
): translations is ReadonlyMap<string, string> {
  return typeof (translations as ReadonlyMap<string, string>).get === "function";
}

function inlineTranslationContainer(element: Element): boolean {
  return /^(li|td|th|dt|dd|summary)$/i.test(element.tagName);
}

function plainTranslationText(value: string): string {
  // Preserve ordinary sentence spacing while removing control characters and
  // a response's accidental leading/trailing blank lines.
  return value.replace(/\u0000/g, "").trim();
}

function parseImmersiveTranslationProgress(
  source: string,
  allowedIds: ReadonlySet<string>,
  parser?: ImmersiveTranslationHtmlParser
): ImmersiveTranslationProgress {
  const translations = new Map<string, string>();
  const pendingIds = new Set<string>();
  const completeIds = new Set<string>();
  const openingTag = /<rh-translation\s+id\s*=\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')\s*>/gi;
  const openings = Array.from(source.matchAll(openingTag));

  for (let index = 0; index < openings.length; index += 1) {
    const opening = openings[index];
    const id = opening[1] || opening[2];
    if (!id || !allowedIds.has(id)) continue;
    const bodyStart = (opening.index ?? 0) + opening[0].length;
    const closeAt = source.indexOf("</rh-translation>", bodyStart);
    const nextOpeningAt = index + 1 < openings.length ? openings[index + 1].index ?? source.length : source.length;
    const isComplete = closeAt >= 0 && closeAt <= nextOpeningAt;
    const bodyEnd = isComplete ? closeAt : Math.min(nextOpeningAt, source.length);
    const text = modelFragmentToPlainText(trimIncompleteProtocolSuffix(source.slice(bodyStart, bodyEnd)), parser);
    if (text) translations.set(id, text);
    if (isComplete) completeIds.add(id);
    else pendingIds.add(id);
  }

  return { translations, pendingIds, completeIds };
}

function modelFragmentToPlainText(fragment: string, parser?: ImmersiveTranslationHtmlParser): string {
  if (!fragment) return "";
  const document = (parser || new DOMParser()).parseFromString(fragment, "text/html");
  return plainTranslationText(document.body.textContent || "");
}

function trimIncompleteProtocolSuffix(fragment: string): string {
  // A close tag can arrive over two stream events. Avoid briefly rendering its
  // partial literal in the translation line; the next delta reconstructs the
  // complete tag from the cumulative response.
  const start = fragment.lastIndexOf("</");
  if (start < 0) return fragment;
  const suffix = fragment.slice(start).toLowerCase();
  return "</rh-translation>".startsWith(suffix) ? fragment.slice(0, start) : fragment;
}

function segmentKind(element: Element): ImmersiveTranslationSegmentKind {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "p") return "paragraph";
  if (tag === "li") return "list-item";
  if (tag === "blockquote") return "quote";
  if (tag === "figcaption") return "caption";
  if (tag === "td" || tag === "th") return "table-cell";
  return "definition";
}

function stableSegmentId(kind: ImmersiveTranslationSegmentKind, sourceText: string, occurrence: number): string {
  return `rh-translation-${kind}-${fnv1a(sourceText)}-${occurrence}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error("沉浸式翻译分段参数必须是正整数。");
  }
  return value;
}
