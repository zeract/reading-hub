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
export const DEFAULT_IMMERSIVE_TRANSLATION_BATCH_SEGMENTS = 6;
export const DEFAULT_IMMERSIVE_TRANSLATION_BATCH_CHARACTERS = 6_000;
/** Keep two turns in flight: enough to hide a slow first turn without overwhelming a local account. */
export const DEFAULT_IMMERSIVE_TRANSLATION_CONCURRENCY = 2;
/** A tiny foreground turn gets the first visible translation on screen quickly. */
export const DEFAULT_IMMERSIVE_TRANSLATION_FOREGROUND_SEGMENTS = 2;
export const DEFAULT_IMMERSIVE_TRANSLATION_FOREGROUND_CHARACTERS = 1_400;

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

/**
 * A two-phase dispatch plan balances perceived latency with total throughput:
 * the first visible prose units are sent in one tiny foreground request, then
 * the rest can use the larger bounded batch policy in the background.
 */
export interface ImmersiveTranslationPriorityBatches {
  foreground?: ImmersiveTranslationBatch;
  background: readonly ImmersiveTranslationBatch[];
}

export interface ImmersiveTranslationPriorityOptions {
  foregroundMaximumSegments?: number;
  foregroundMaximumCharacters?: number;
  background?: ImmersiveTranslationBatchOptions;
}

export interface ImmersiveTranslationDispatchOptions {
  /** Total provider turns allowed across foreground and background work. */
  concurrency?: number;
  /** Lets the owning React effect stop scheduling work after cleanup. */
  isCancelled?: () => boolean;
  /** Calls `onFirstTranslation` once a safe first translated line is visible. */
  runForeground: (batch: ImmersiveTranslationBatch, onFirstTranslation: () => void) => Promise<boolean>;
  runBackground: (batch: ImmersiveTranslationBatch) => Promise<boolean>;
}

/**
 * Owns the short-lived generation of one rendered translation plan. Keeping
 * this separate from request ids makes language/article changes explicit: a
 * late IPC event can be discarded before it touches cache or React state.
 */
export class ImmersiveTranslationRunController {
  private runId = 0;

  begin(): number {
    this.runId += 1;
    return this.runId;
  }

  invalidate(id: number): void {
    if (this.runId === id) this.runId += 1;
  }

  owns(id: number): boolean {
    return this.runId === id;
  }

  get current(): number {
    return this.runId;
  }
}

type CachedTranslation = { sourceText: string; translation: string; characters: number };
const SESSION_TRANSLATION_CACHE_MAX_ENTRIES = 1_200;
/** Keep in-process convenience caching comfortably below a large article's DOM budget. */
const SESSION_TRANSLATION_CACHE_MAX_CHARACTERS = 1_500_000;
/** A malformed provider response must never become a giant retained cache entry. */
const SESSION_TRANSLATION_CACHE_MAX_ENTRY_CHARACTERS = 6_000;
const sessionTranslationCache = new Map<string, CachedTranslation>();
let sessionTranslationCacheCharacters = 0;

/**
 * Process-memory-only cache. It makes a close/reopen or language switch-back
 * instantaneous without writing article text or translations to SQLite or disk.
 */
export function readImmersiveTranslationCache(scope: string, target: "zh" | "en", segments: readonly ImmersiveTranslationSegment[]): Map<string, string> {
  const translations = new Map<string, string>();
  for (const segment of segments) {
    const key = translationCacheKey(scope, target, segment.id);
    const cached = sessionTranslationCache.get(key);
    if (!cached || cached.sourceText !== segment.sourceText) continue;
    // Map insertion order gives us a deterministic O(1) LRU list. Refreshing
    // an entry by moving it to the end is more reliable than timestamp ties
    // when several streamed paragraphs arrive in the same millisecond.
    touchSessionTranslationCache(key, cached);
    translations.set(segment.id, cached.translation);
  }
  return translations;
}

/** Store only complete, non-empty translations and bound retained memory. */
export function writeImmersiveTranslationCache(scope: string, target: "zh" | "en", segments: readonly ImmersiveTranslationSegment[], translations: ReadonlyMap<string, string>, completeIds?: ReadonlySet<string>): void {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  for (const [id, translation] of translations) {
    if (completeIds && !completeIds.has(id)) continue;
    const segment = byId.get(id);
    const text = plainTranslationText(translation);
    if (!segment || !text) continue;
    const entry = { sourceText: segment.sourceText, translation: text, characters: segment.sourceText.length + text.length };
    if (entry.characters > SESSION_TRANSLATION_CACHE_MAX_ENTRY_CHARACTERS) continue;
    touchSessionTranslationCache(translationCacheKey(scope, target, id), entry);
  }
  while (sessionTranslationCache.size > SESSION_TRANSLATION_CACHE_MAX_ENTRIES
    || sessionTranslationCacheCharacters > SESSION_TRANSLATION_CACHE_MAX_CHARACTERS) {
    const oldestKey = sessionTranslationCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    deleteSessionTranslationCacheEntry(oldestKey);
  }
}

/** Test/support hook; content is never persisted outside this renderer process. */
export function clearImmersiveTranslationCache(): void {
  sessionTranslationCache.clear();
  sessionTranslationCacheCharacters = 0;
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
  const maximumSegments = boundedPositiveInteger(options.maximumSegments, DEFAULT_IMMERSIVE_TRANSLATION_BATCH_SEGMENTS);
  const maximumCharacters = boundedPositiveInteger(options.maximumCharacters, DEFAULT_IMMERSIVE_TRANSLATION_BATCH_CHARACTERS);
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
 * Preserve document order while creating a latency-sensitive first batch.
 * A single source block is never split: if the first block alone exceeds the
 * foreground character target, it is still sent immediately rather than being
 * delayed behind a later batch.
 */
export function prioritiseImmersiveTranslationBatches(
  segments: readonly ImmersiveTranslationSegment[],
  options: ImmersiveTranslationPriorityOptions = {}
): ImmersiveTranslationPriorityBatches {
  const foregroundMaximumSegments = boundedPositiveInteger(
    options.foregroundMaximumSegments,
    DEFAULT_IMMERSIVE_TRANSLATION_FOREGROUND_SEGMENTS
  );
  const foregroundMaximumCharacters = boundedPositiveInteger(
    options.foregroundMaximumCharacters,
    DEFAULT_IMMERSIVE_TRANSLATION_FOREGROUND_CHARACTERS
  );
  const foregroundSegments: ImmersiveTranslationSegment[] = [];
  let foregroundCharacters = 0;

  for (const segment of segments) {
    const exceedsForeground = foregroundSegments.length > 0 && (
      foregroundSegments.length >= foregroundMaximumSegments
      || foregroundCharacters + segment.sourceText.length > foregroundMaximumCharacters
    );
    if (exceedsForeground) break;
    foregroundSegments.push(segment);
    foregroundCharacters += segment.sourceText.length;
  }

  const foreground = foregroundSegments.length
    ? { index: 0, segments: foregroundSegments, characterCount: foregroundCharacters }
    : undefined;
  const background = batchImmersiveTranslationSegments(segments.slice(foregroundSegments.length), options.background)
    .map((batch, index) => ({ ...batch, index: index + (foreground ? 1 : 0) }));
  return { foreground, background };
}

/**
 * Run a foreground batch for perceived latency, then dynamically fill the
 * remaining bounded slots. When the foreground completes before a long tail
 * of background batches, this adds the released slot instead of leaving the
 * tail serial. The scheduler is provider-agnostic and deterministic enough to
 * exercise without a live model.
 */
export async function dispatchImmersiveTranslationBatches(
  dispatch: ImmersiveTranslationPriorityBatches,
  options: ImmersiveTranslationDispatchOptions
): Promise<boolean> {
  if (!dispatch.foreground) return true;
  const concurrency = boundedPositiveInteger(options.concurrency, DEFAULT_IMMERSIVE_TRANSLATION_CONCURRENCY);
  const isCancelled = options.isCancelled || (() => false);
  let nextBackground = 0;
  let failed = false;
  const workers: Array<Promise<void>> = [];

  const runBackgroundWorker = async () => {
    while (!isCancelled() && !failed) {
      const batch = dispatch.background[nextBackground++];
      if (!batch) return;
      try {
        if (!(await options.runBackground(batch))) failed = true;
      } catch {
        failed = true;
      }
    }
  };
  const startBackgroundWorker = (): boolean => {
    if (isCancelled() || failed || nextBackground >= dispatch.background.length) return false;
    workers.push(runBackgroundWorker());
    return true;
  };
  let releaseFirstTranslation!: () => void;
  let firstReleased = false;
  const firstTranslation = new Promise<void>((resolve) => {
    releaseFirstTranslation = () => {
      if (firstReleased) return;
      firstReleased = true;
      resolve();
    };
  });
  const foreground = Promise.resolve(options.runForeground(dispatch.foreground, releaseFirstTranslation))
    .catch(() => false)
    .then((ok) => {
      if (!ok) failed = true;
      releaseFirstTranslation();
      return ok;
    });

  // Preserve foreground first-token priority. Only one fewer background
  // worker starts until foreground no longer owns a slot.
  await Promise.race([firstTranslation, foreground.then(() => undefined)]);
  if (!isCancelled() && !failed) {
    const initialWorkers = Math.min(Math.max(0, concurrency - 1), dispatch.background.length);
    for (let index = 0; index < initialWorkers; index += 1) startBackgroundWorker();
  }
  await foreground;
  if (!isCancelled() && !failed) {
    const desiredWorkers = Math.min(concurrency, dispatch.background.length);
    while (workers.length < desiredWorkers && startBackgroundWorker()) {
      // Each started worker owns a bounded slot until it drains the queue.
    }
  }
  await Promise.all(workers);
  return !isCancelled() && !failed;
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
  // Keep the deterministic helper/tests on the same insertion path as the
  // live reader so the two rendering modes cannot silently drift apart.
  applyImmersiveTranslationPatches(document.body, plan, translations, options);
  return document.body.innerHTML;
}

/**
 * Update a live reader DOM without replacing the article body. This avoids
 * reparsing remote HTML, reloading images, and recreating mathematical DOM on
 * every streamed token. Translations still enter solely through textContent.
 */
export function applyImmersiveTranslationPatches(
  root: Element,
  plan: ImmersiveTranslationPlan,
  translations: ReadonlyMap<string, string> | Readonly<Record<string, string | undefined>>,
  options: Pick<ImmersiveTranslationRenderOptions, "targetLanguage"> = {}
): void {
  const allowedIds = new Set(plan.segments.map(({ id }) => id));
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}]`))) {
    const id = element.getAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE);
    if (!id || !allowedIds.has(id)) continue;
    const translation = translationForId(translations, id);
    const existing = translationResultFor(element, id);
    if (!translation) {
      existing?.remove();
      continue;
    }
    const text = plainTranslationText(translation);
    if (!text) {
      existing?.remove();
      continue;
    }
    const result = existing || root.ownerDocument.createElement(inlineTranslationContainer(element) ? "span" : "div");
    if (!existing) {
      result.className = "reader-immersive-translation";
      result.setAttribute(IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE, id);
      result.setAttribute("dir", "auto");
      if (inlineTranslationContainer(element)) element.append(result);
      else element.insertAdjacentElement("afterend", result);
    }
    if (options.targetLanguage) result.setAttribute("lang", options.targetLanguage);
    // rAF coalescing can still revisit earlier segments. Avoid invalidating
    // layout/selection for a line whose streamed text did not change.
    if (result.textContent !== text) result.textContent = text;
  }
}

/**
 * A batch succeeds only when every requested segment has a non-empty,
 * explicitly closed protocol block. A length-limited model response therefore
 * becomes a recoverable partial result instead of a misleading completion.
 */
export function missingCompletedImmersiveTranslationSegments(
  segments: readonly ImmersiveTranslationSegment[],
  progress: Pick<ImmersiveTranslationProgress, "translations" | "completeIds">
): readonly ImmersiveTranslationSegment[] {
  return segments.filter((segment) => {
    const translation = progress.translations.get(segment.id);
    return !progress.completeIds.has(segment.id) || !translation || !plainTranslationText(translation);
  });
}

/**
 * Parses streamed protocol tags across arbitrary IPC chunk boundaries. It is
 * intentionally tolerant of a missing final close tag so the first translated
 * paragraph can render while the provider is still producing the rest.
 */
export function createImmersiveTranslationStreamParser(
  allowedSegmentIds: Iterable<string>,
  // Kept for source compatibility with deterministic renderer tests. Streamed
  // provider text intentionally no longer goes through DOMParser per delta.
  // Doing so made a long response quadratic and repeatedly allocated full
  // documents merely to discard any accidental markup.
  _options: Pick<ImmersiveTranslationRenderOptions, "parser"> = {}
): ImmersiveTranslationStreamParser {
  const allowedIds = new Set(allowedSegmentIds);
  const translations = new Map<string, string>();
  const completeIds = new Set<string>();
  let buffer = "";
  let activeId: string | undefined;
  let activeText = createPlainTextStreamDecoder();
  let discarding = false;

  const progress = (): ImmersiveTranslationProgress => ({
    translations: new Map(translations),
    pendingIds: activeId ? new Set([activeId]) : new Set(),
    completeIds: new Set(completeIds)
  });

  const flushActive = () => {
    if (!activeId) return;
    const text = activeText.value();
    if (text) translations.set(activeId, text);
  };

  return {
    push(delta: string): ImmersiveTranslationProgress {
      buffer += delta;
      while (buffer) {
        if (activeId || discarding) {
          const closeAt = buffer.toLowerCase().indexOf("</rh-translation>");
          if (closeAt < 0) {
            const retained = incompleteProtocolPrefixLength(buffer, "</rh-translation>");
            if (activeId) { activeText.push(buffer.slice(0, buffer.length - retained)); flushActive(); }
            buffer = retained ? buffer.slice(-retained) : "";
            break;
          }
          if (activeId) {
            activeText.push(buffer.slice(0, closeAt));
            activeText.finish();
            flushActive();
            completeIds.add(activeId);
          }
          buffer = buffer.slice(closeAt + "</rh-translation>".length);
          activeId = undefined;
          activeText = createPlainTextStreamDecoder();
          discarding = false;
          continue;
        }

        const openingAt = buffer.toLowerCase().indexOf("<rh-translation");
        if (openingAt < 0) {
          // Keep only a potential split opening tag; commentary outside the
          // protocol is intentionally ignored and never reaches the reader.
          buffer = buffer.slice(-"<rh-translation".length);
          break;
        }
        buffer = buffer.slice(openingAt);
        const openingEnd = buffer.indexOf(">");
        if (openingEnd < 0) break;
        const opening = buffer.slice(0, openingEnd + 1);
        const id = opening.match(/\bid\s*=\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')/i)?.slice(1).find(Boolean);
        activeId = id && allowedIds.has(id) ? id : undefined;
        activeText = createPlainTextStreamDecoder();
        discarding = !activeId;
        buffer = buffer.slice(openingEnd + 1);
      }
      return progress();
    },
    reset(): void {
      translations.clear();
      completeIds.clear();
      buffer = "";
      activeId = undefined;
      activeText = createPlainTextStreamDecoder();
      discarding = false;
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

function translationCacheKey(scope: string, target: "zh" | "en", id: string): string {
  return `${scope}\u0000${target}\u0000${id}`;
}

function touchSessionTranslationCache(key: string, entry: CachedTranslation): void {
  deleteSessionTranslationCacheEntry(key);
  sessionTranslationCache.set(key, entry);
  sessionTranslationCacheCharacters += entry.characters;
}

function deleteSessionTranslationCacheEntry(key: string): void {
  const existing = sessionTranslationCache.get(key);
  if (!existing) return;
  sessionTranslationCache.delete(key);
  sessionTranslationCacheCharacters = Math.max(0, sessionTranslationCacheCharacters - existing.characters);
}

function translationResultFor(element: Element, id: string): HTMLElement | undefined {
  if (inlineTranslationContainer(element)) {
    return Array.from(element.children).find((child) => child.getAttribute(IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE) === id) as HTMLElement | undefined;
  }
  const sibling = element.nextElementSibling;
  return sibling?.getAttribute(IMMERSIVE_TRANSLATION_RESULT_ATTRIBUTE) === id ? sibling as HTMLElement : undefined;
}

/**
 * The model is instructed to return text inside protocol tags. This tiny
 * state machine defensively removes accidental HTML-like tags and decodes
 * common entities, while processing only the newly received delta. It avoids
 * a DOMParser allocation and a full-response scan for every token.
 */
function createPlainTextStreamDecoder(): { push(value: string): void; finish(): void; value(): string } {
  let text = "";
  let markup = "";
  let entity = "";

  const append = (value: string) => { text += value; };
  const flushMarkup = () => {
    if (markup) append(markup);
    markup = "";
  };
  const flushEntity = () => {
    if (entity) append(entity);
    entity = "";
  };

  return {
    push(value: string): void {
      for (const character of value) {
        if (markup) {
          markup += character;
          if (markup.length === 2 && !/[A-Za-z/!?]/.test(character)) {
            flushMarkup();
          } else if (character === ">") {
            // Only strip familiar presentation tags. Treat `<y>` in `x<y>z`
            // as ordinary mathematical prose rather than accidental markup.
            if (harmlessModelMarkup(markup)) {
              if (/^<\/?br\b/i.test(markup)) append(" ");
              markup = "";
            } else {
              flushMarkup();
            }
          } else if (markup.length > 256) {
            flushMarkup();
          }
          continue;
        }
        if (entity) {
          entity += character;
          if (character === ";") {
            append(decodeHtmlEntity(entity));
            entity = "";
          } else if (!/[A-Za-z0-9#]/.test(character) || entity.length > 16) {
            flushEntity();
          }
          continue;
        }
        if (character === "<") {
          markup = character;
        } else if (character === "&") {
          entity = character;
        } else {
          append(character);
        }
      }
    },
    finish(): void {
      flushMarkup();
      flushEntity();
    },
    value(): string {
      return plainTranslationText(text);
    }
  };
}

function decodeHtmlEntity(value: string): string {
  const named: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
    "&copy;": "©", "&reg;": "®", "&trade;": "™", "&ndash;": "–", "&mdash;": "—", "&hellip;": "…",
    "&lsquo;": "‘", "&rsquo;": "’", "&ldquo;": "“", "&rdquo;": "”", "&laquo;": "«", "&raquo;": "»"
  };
  if (named[value]) return named[value];
  const numeric = value.match(/^&#(x[0-9a-f]+|\d+);$/i)?.[1];
  if (!numeric) return value;
  const codePoint = numeric.toLowerCase().startsWith("x")
    ? Number.parseInt(numeric.slice(1), 16)
    : Number.parseInt(numeric, 10);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return value;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return value;
  }
}

function harmlessModelMarkup(value: string): boolean {
  const match = value.match(/^<\/?\s*([A-Za-z][A-Za-z0-9-]*)\b[^>]*>$/);
  if (!match) return false;
  return new Set([
    "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "mark", "small", "sub", "sup",
    "span", "div", "p", "br", "code", "pre", "kbd", "samp", "blockquote", "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6"
  ]).has(match[1].toLowerCase());
}

function incompleteProtocolPrefixLength(value: string, token: string): number {
  const lower = value.toLowerCase();
  for (let length = Math.min(token.length - 1, lower.length); length > 0; length -= 1) {
    if (token.startsWith(lower.slice(-length))) return length;
  }
  return 0;
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
