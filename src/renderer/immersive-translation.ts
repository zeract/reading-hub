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
/**
 * A moderate batch avoids tail latency and output truncation on fast API
 * models, while still amortising a local Codex App Server turn setup.
 */
export const DEFAULT_IMMERSIVE_TRANSLATION_BATCH_SEGMENTS = 4;
export const DEFAULT_IMMERSIVE_TRANSLATION_BATCH_CHARACTERS = 3_600;
/** Keep two turns in flight: enough to hide a slow first turn without overwhelming a local account. */
export const DEFAULT_IMMERSIVE_TRANSLATION_CONCURRENCY = 2;
/** A tiny foreground turn gets the first visible translation on screen quickly. */
export const DEFAULT_IMMERSIVE_TRANSLATION_FOREGROUND_SEGMENTS = 1;
export const DEFAULT_IMMERSIVE_TRANSLATION_FOREGROUND_CHARACTERS = 800;
/**
 * A page with thousands of tiny table cells must not turn into thousands of
 * provider requests. Normal prose articles remain comfortably within this
 * bound; unusually dense pages report that later blocks were skipped.
 */
export const DEFAULT_IMMERSIVE_TRANSLATION_PLAN_SEGMENTS = 64;
const DEFAULT_IMMERSIVE_TRANSLATION_PLAN_CANDIDATES = DEFAULT_IMMERSIVE_TRANSLATION_PLAN_SEGMENTS * 4;

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
  /**
   * Bounds total provider work for dense tables/lists. Later prose remains
   * untouched and the returned plan is marked truncated for a clear UI hint.
   */
  maximumSegments?: number;
  /**
   * Bounds DOM text extraction itself before an adversarially dense document
   * can make planning expensive. This is intentionally higher than the
   * segment limit so normal nested prose still retains its leaf structure.
   */
  maximumCandidates?: number;
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

export interface ImmersiveTranslationViewport {
  top: number;
  bottom: number;
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
const planSegmentIds = new WeakMap<ImmersiveTranslationPlan, ReadonlySet<string>>();

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
  /**
   * Latest safe plain-text translation for each recognised segment id.
   * This is a live, read-only view owned by the parser. Consumers that need a
   * durable snapshot should copy it explicitly; copying it for every token
   * made a multi-paragraph stream needlessly quadratic.
   */
  translations: ReadonlyMap<string, string>;
  /** Only the segment values that changed while processing this delta. */
  changedTranslations: ReadonlyMap<string, string>;
  /** IDs still receiving text because their closing protocol tag has not arrived. */
  pendingIds: ReadonlySet<string>;
  /** Live set of IDs whose closing protocol tag has arrived. */
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
  const maximumSegments = boundedPositiveInteger(
    options.maximumSegments,
    DEFAULT_IMMERSIVE_TRANSLATION_PLAN_SEGMENTS
  );
  const maximumCandidates = boundedPositiveInteger(
    options.maximumCandidates,
    DEFAULT_IMMERSIVE_TRANSLATION_PLAN_CANDIDATES
  );
  const body = document.body;

  // Never trust a stale or source-provided annotation as a translation target.
  for (const element of Array.from(body.querySelectorAll(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}]`))) {
    element.removeAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE);
  }

  const candidates: HTMLElement[] = [];
  let truncated = false;
  const candidateNodes = body.querySelectorAll<HTMLElement>(TRANSLATABLE_BLOCK_SELECTOR);
  for (let index = 0; index < candidateNodes.length; index += 1) {
    const element = candidateNodes[index];
    if (isWithinNonTranslatableContent(element)) continue;
    if (candidates.length >= maximumCandidates) {
      truncated = true;
      break;
    }
    candidates.push(element);
  }
  // Work out viable source text before looking for nested candidates. A
  // formula-only child must not suppress a useful parent list item or quote.
  const candidateSourceText = new Map(
    candidates
      .map((element) => [element, sourceTextForTranslation(element)] as const)
      .filter(([, sourceText]) => hasTranslatableProse(sourceText))
  );
  const candidateSet = new Set(candidateSourceText.keys());
  const candidatesWithEligibleDescendant = new Set<Element>();
  for (const descendant of candidateSet) {
    let ancestor = descendant.parentElement;
    while (ancestor && ancestor !== body) {
      if (candidateSet.has(ancestor)) candidatesWithEligibleDescendant.add(ancestor);
      ancestor = ancestor.parentElement;
    }
  }
  const segments: ImmersiveTranslationSegment[] = [];
  const duplicateOccurrences = new Map<string, number>();
  let usedCharacters = 0;

  for (const element of candidates) {
    if (candidatesWithEligibleDescendant.has(element)) continue;
    const sourceText = candidateSourceText.get(element);
    if (!sourceText) continue;
    if (segments.length >= maximumSegments) {
      truncated = true;
      break;
    }
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
    segments.push({ id, kind, sourceText });
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
 * Keep visual reading responsive when translation is enabled mid-article.
 * Visible blocks are requested first, then the remaining blocks retain their
 * source order. DOM placement is still controlled by each segment id, so this
 * only changes request order and never the article's reading order.
 */
export function prioritiseImmersiveTranslationSegmentsForViewport(
  segments: readonly ImmersiveTranslationSegment[],
  sourceElements: ReadonlyMap<string, Element>,
  viewport: ImmersiveTranslationViewport
): readonly ImmersiveTranslationSegment[] {
  return segments
    .map((segment, index) => ({ segment, index, distance: translationSegmentViewportDistance(sourceElements.get(segment.id), viewport) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .map(({ segment }) => segment);
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

export interface ImmersiveTranslationPatchOptions {
  /** A language hint lets assistive technology announce the translated line correctly. */
  targetLanguage?: "zh" | "en";
  /**
   * A streaming update normally changes just one protocol block. Passing its
   * id avoids a full-document scan and avoids touching unrelated selections.
   */
  changedIds?: Iterable<string>;
  /**
   * Index the current, static reader DOM once after it mounts. The patcher
   * validates entries before using them and falls back safely if React has
   * replaced the reader body.
   */
  sourceElements?: ReadonlyMap<string, HTMLElement>;
}

/** Build a stable lookup after the sanitised reader body mounts. */
export function indexImmersiveTranslationSourceElements(
  root: Element,
  plan: ImmersiveTranslationPlan
): Map<string, HTMLElement> {
  const allowedIds = immersiveTranslationPlanIds(plan);
  const sourceElements = new Map<string, HTMLElement>();
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}]`))) {
    const id = element.getAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE);
    if (!id || !allowedIds.has(id) || sourceElements.has(id)) continue;
    sourceElements.set(id, element);
  }
  return sourceElements;
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
  options: ImmersiveTranslationPatchOptions = {}
): void {
  const allowedIds = immersiveTranslationPlanIds(plan);
  const sourceElements = options.sourceElements || indexImmersiveTranslationSourceElements(root, plan);
  const targetIds = options.changedIds ? new Set(options.changedIds) : allowedIds;
  for (const id of targetIds) {
    if (!allowedIds.has(id)) continue;
    const indexed = sourceElements.get(id);
    const element = indexed && root.contains(indexed)
      && indexed.getAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE) === id
      ? indexed
      : translationSourceElementForId(root, id);
    if (!element) continue;
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
 * Clears transient text for a failed or incomplete request batch. The caller
 * can pass the returned ids straight to `applyImmersiveTranslationPatches` so
 * a half-generated line never remains visible after its stream ends.
 */
export function discardImmersiveTranslationSegments(
  translations: Map<string, string>,
  segments: readonly Pick<ImmersiveTranslationSegment, "id">[]
): Set<string> {
  const changedIds = new Set<string>();
  for (const { id } of segments) {
    translations.delete(id);
    // Patch even when the map no longer contains the id. A prior rAF can have
    // already inserted the DOM node before a provider error reaches us.
    changedIds.add(id);
  }
  return changedIds;
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

  const progress = (changedTranslations: ReadonlyMap<string, string>): ImmersiveTranslationProgress => ({
    translations,
    changedTranslations,
    pendingIds: activeId ? new Set([activeId]) : new Set(),
    completeIds
  });

  const flushActive = (changedTranslations: Map<string, string>) => {
    if (!activeId) return;
    const text = activeText.value();
    if (!text || translations.get(activeId) === text) return;
    translations.set(activeId, text);
    changedTranslations.set(activeId, text);
  };

  return {
    push(delta: string): ImmersiveTranslationProgress {
      const changedTranslations = new Map<string, string>();
      buffer += delta;
      while (buffer) {
        if (activeId || discarding) {
          const closeAt = buffer.toLowerCase().indexOf("</rh-translation>");
          if (closeAt < 0) {
            const retained = incompleteProtocolPrefixLength(buffer, "</rh-translation>");
            if (activeId) {
              activeText.push(buffer.slice(0, buffer.length - retained));
              flushActive(changedTranslations);
            }
            buffer = retained ? buffer.slice(-retained) : "";
            break;
          }
          if (activeId) {
            activeText.push(buffer.slice(0, closeAt));
            activeText.finish();
            flushActive(changedTranslations);
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
      return progress(changedTranslations);
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
  // Most streamed deltas are already clean prose. Avoid allocating/scanning a
  // growing paragraph on every token; only materialise a normalized string
  // when a control character or boundary whitespace is actually present.
  if (!value.includes("\u0000") && !/^\s|\s$/.test(value)) return value;
  return value.replace(/\u0000/g, "").trim();
}

function translationCacheKey(scope: string, target: "zh" | "en", id: string): string {
  return `${scope}\u0000${target}\u0000${id}`;
}

function immersiveTranslationPlanIds(plan: ImmersiveTranslationPlan): ReadonlySet<string> {
  const cached = planSegmentIds.get(plan);
  if (cached) return cached;
  const ids = new Set(plan.segments.map(({ id }) => id));
  planSegmentIds.set(plan, ids);
  return ids;
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

function translationSourceElementForId(root: Element, id: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE}]`))
    .find((element) => element.getAttribute(IMMERSIVE_TRANSLATION_SEGMENT_ATTRIBUTE) === id);
}

function translationSegmentViewportDistance(element: Element | undefined, viewport: ImmersiveTranslationViewport): number {
  if (!element) return Number.POSITIVE_INFINITY;
  const rect = element.getBoundingClientRect();
  if (rect.bottom < viewport.top) return viewport.top - rect.bottom;
  if (rect.top > viewport.bottom) return rect.top - viewport.bottom;
  return 0;
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
