import { load } from "cheerio";
import { ArticleReader } from "./article-reader";
import { ReadingDatabase } from "./database";
import { PublicHttpClient, UnsupportedReaderImageTypeError } from "./http";
import { IsolatedPageRenderer } from "./page-renderer";
import { RobotsDisallowedError } from "./robots";
import { ZhihuFollowConnector } from "./zhihu-follow";
import type { Entry, ReaderArticle, Source } from "../shared/types";

const DEFAULT_READ_TIMEOUT_MS = 45_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 25_000;
const DEFAULT_SAMPLE_DELAY_MS = 400;
const DEFAULT_HEARTBEAT_MS = 5_000;

export type ReaderAuditResult = {
  source: string;
  kind: Source["kind"];
  entry?: string;
  profile?: ReaderArticle["renderProfile"];
  textLength?: number;
  images?: number;
  /** Safe metadata about expected image fallback exclusions, never image data. */
  imageDiagnostics?: string[];
  /** Safe per-viewport layout diagnostics; article HTML is never reported. */
  visualDiagnostics?: string[];
  katexBlocks?: number;
  mathJaxBlocks?: number;
  mathJaxSpacerNodes?: number;
  /** Count-only formula ingestion telemetry; no TeX or page HTML is reported. */
  formulaCounts?: ReaderArticle["formulaDiagnostics"];
  formulaDiagnostics?: string[];
  rawTeXDiagnostics?: string[];
  renderedMathDiagnostics?: string[];
  mode?: "article" | "feed_body" | "feed_summary" | "embedded";
  sample?: ReaderAuditSampleKind;
  status?: "passed" | "issues" | "skipped" | "failed" | "timed_out";
  durationMs?: number;
  issues: string[];
};

export type ReaderAuditProgress = {
  phase: "started" | "waiting" | "finished" | "source_skipped";
  completed: number;
  total: number;
  source: string;
  kind: Source["kind"];
  entry?: string;
  sample?: ReaderAuditSampleKind;
  stage?: "read" | "image" | "layout";
  elapsedMs?: number;
  status?: ReaderAuditResult["status"];
  issueCount?: number;
};

export interface ReaderAuditOptions {
  sourceFilter?: string;
  /**
   * Audit every saved entry for the selected source(s). This is intentionally
   * opt-in: the default release check remains a polite newest-plus-history
   * sample, while source-specific investigations can establish full coverage.
   */
  allEntries?: boolean;
  readTimeoutMs?: number;
  imageTimeoutMs?: number;
  layoutTimeoutMs?: number;
  sampleDelayMs?: number;
  heartbeatMs?: number;
  /** Receives safe metadata only; article HTML and credentials are never reported. */
  onProgress?: (progress: ReaderAuditProgress) => void | Promise<void>;
  onResult?: (result: ReaderAuditResult) => void | Promise<void>;
  /**
   * Optional in-memory layout inspection. The callback must return diagnostics
   * only and must not retain article HTML; it is used by the explicit
   * display-equation visual audit mode.
   */
  inspectLayout?: (article: ReaderArticle, source: Source, entry: Entry) => Promise<string[] | undefined> | string[] | undefined;
}

export class ReaderAuditTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}超时（${Math.ceil(timeoutMs / 1_000)} 秒），已取消该样本的网络与页面渲染工作。`);
    this.name = "ReaderAuditTimeoutError";
  }
}

function plainText(html: string): string {
  return load(html).text().replace(/\s+/g, " ").trim();
}

function hasDisplayFormula(article: ReaderArticle): boolean {
  if (article.formulaDiagnostics && article.formulaDiagnostics.total === 0) return false;
  // Source semantics are authoritative. If the rendered document has no
  // block wrapper despite a semantic block formula, still run the layout audit
  // so this becomes an actionable failure rather than a false pass.
  if ((article.formulaDiagnostics?.display ?? 0) > 0) return true;
  const document = load(article.contentHtml);
  return document("[data-reader-equation], .katex-display, mjx-container[display='true']").length > 0;
}

/**
 * Card summaries can lead straight into raw TeX while the reader correctly
 * turns that TeX into a rendered formula. Compare only authored prose before
 * an explicit math delimiter, otherwise a safe rendering transformation looks
 * like an incorrect Scientific Spaces extraction root.
 */
export function readerAuditSummaryLead(summary: string | undefined): string {
  const text = plainText(summary || "");
  const prose = text.split(/(?:\$\$|\\\[|\\\(|\\begin\{)/, 1)[0];
  return prose.trim().slice(0, 28);
}

function countMatches(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
}

/**
 * Finds dollar-delimited TeX that escaped the reader pipeline. This remains a
 * deliberately conservative audit rather than a second formula parser: a
 * pair of currency markers can span an ordinary sentence, and social handles
 * often contain a trailing underscore. Those are not evidence of a broken
 * inline formula.
 */
export function findLeakedInlineMath(value: string): string[] {
  const fragments: string[] = [];
  const expression = /(?<!\\)\$([^$\r\n]{1,400})\$/g;
  for (const match of value.matchAll(expression)) {
    const formula = match[1].trim();
    const hasTeXCommand = /\\[A-Za-z]+/.test(formula);
    // Require a complete sub/superscript such as `q_i`, `q_{i}` or `x^2`.
    // A lone underscore at the end of an account name (for example
    // `@someone_`) is ordinary prose, not mathematical syntax.
    const hasScript = /[A-Za-zα-ωΑ-Ω0-9)}\]]\s*[_^]\s*(?:\{[^}\r\n]+\}|[A-Za-zα-ωΑ-Ω0-9])/.test(formula);
    // A multiplication glyph alone is common in price/specification prose
    // (for example "$19,200/mo … 2× NVMe … ~$") and is not enough evidence
    // of a leaked formula. Real multiplication is normally accompanied by a
    // TeX command, script or equation relation, all handled above.
    const hasOperator = /[=<>±÷]/.test(formula);
    const standaloneSymbol = /^[A-Za-zα-ωΑ-Ω][A-Za-z0-9α-ωΑ-Ω]*$/.test(formula);
    const sentenceLike = /(?:^|[.!?])\s+(?:@|https?:\/\/|[A-Z])/.test(formula);
    // A valid TeX expression may contain prose through `\\text{…}`, so only
    // reject sentence-shaped content when it has no unambiguous TeX command.
    if ((hasTeXCommand || hasScript || hasOperator || standaloneSymbol) && !(sentenceLike && !hasTeXCommand)) {
      fragments.push(`$${formula}$`);
    }
  }
  return fragments;
}

function inspectArticle(source: Source, entry: Entry, article: ReaderArticle): ReaderAuditResult {
  const html = article.contentHtml;
  const text = plainText(html);
  const firstText = text.slice(0, 700);
  const formulaFallbacks = countMatches(html, /class="reader-math-source(?:\s|"|--)/gi);
  const fallbackFormulae = load(html)(".reader-math-source").toArray()
    .map((node) => plainText(load(node).html() || ""))
    .filter(Boolean)
    .slice(0, 2)
    .map((formula) => formula.replace(/\s+/g, " ").slice(0, 220));
  const formulaDocument = load(html);
  const formulaErrors = formulaDocument(".katex-error, mjx-merror").toArray()
    .map((node) => {
      const element = formulaDocument(node);
      return element.attr("title") || plainText(element.html() || "");
    })
    .filter(Boolean)
    .slice(0, 2)
    .map((formula) => formula.replace(/\s+/g, " ").slice(0, 220));
  const renderedMathTeX = load(html)("mjx-container").toArray()
    .map((node) => plainText(load(node).html() || ""))
    .filter((formula) => /\\(?:[A-Za-z]+|[{}\[\]\\])/.test(formula))
    .slice(0, 2)
    .map((formula) => formula.replace(/\s+/g, " ").slice(0, 220));
  const mathJaxSpacerNodes = countMatches(html, /<mjx-spacer\b/gi);
  const unrendered = load(`<article id="audit-content">${html}</article>`);
  // KaTeX keeps original TeX in an accessibility annotation. It is expected
  // invisible metadata, not a reader failure, so inspect only text outside
  // rendered formulas and literal code when detecting leaked source TeX.
  unrendered("#audit-content .katex, #audit-content mjx-container, #audit-content .reader-math-source, #audit-content pre, #audit-content code").remove();
  const unrenderedHtml = unrendered("#audit-content").html() || "";
  const rawTeXCommands = plainText(unrenderedHtml).match(/\\(?:[A-Za-z]+|[{}\[\]\\])[^\s<]{0,180}/g) || [];
  const rawInlineTeX = findLeakedInlineMath(plainText(unrenderedHtml));
  const rawFormulaDiagnostics = [...rawTeXCommands, ...rawInlineTeX].slice(0, 2);
  const issues: string[] = [];
  const formulaCounts = article.formulaDiagnostics;
  // Follow-feed cards can legitimately be a short public status update rather
  // than a long-form article. Their in-app display is still valid.
  if (text.length < 180 && source.kind !== "zhihu_follow" && source.kind !== "academic" && article.contentMode !== "feed_body" && article.contentMode !== "feed_summary") issues.push("正文过短");
  const sanitised = load(`<article id="audit-sanitised">${html}</article>`);
  const executableElement = sanitised("script, iframe, object, embed").length > 0 || sanitised("#audit-sanitised *").toArray().some((node: any) => {
    const attributes = node.attribs || {};
    return Object.entries(attributes).some(([name, value]) => /^on/i.test(name)
      || ((name.toLowerCase() === "href" || name.toLowerCase() === "src") && /^\s*javascript:/i.test(String(value))));
  });
  if (executableElement) issues.push("净化失败：发现可执行标记");
  // Inspect rendered nodes rather than searching raw HTML. A technical
  // article can legitimately mention `katex-error` inside a code example.
  if (formulaDocument(".katex-error, mjx-merror").length || /READING_HUB_MATH/.test(plainText(unrenderedHtml))) {
    issues.push("公式渲染失败或残留占位符");
  }
  if (formulaFallbacks) issues.push(`公式降级为原始 TeX 卡片（${formulaFallbacks} 处）`);
  if (formulaCounts && formulaCounts.dropped > 0) issues.push(`公式语义提取丢失（${formulaCounts.dropped} 处）`);
  if (formulaCounts && formulaCounts.total !== formulaCounts.rendered + formulaCounts.fallback + formulaCounts.dropped) {
    issues.push("公式语义提取计数不一致");
  }
  const renderedDisplayBlocks = formulaDocument("[data-reader-equation]").length;
  const fallbackDisplayBlocks = formulaDocument(".reader-math-source--block").length;
  if (formulaCounts && formulaCounts.display !== formulaCounts.displayRendered + formulaCounts.displayFallback + formulaCounts.displayDropped) {
    issues.push("块公式语义提取计数不一致");
  }
  if (formulaCounts && formulaCounts.displayRendered !== renderedDisplayBlocks) {
    issues.push(`块公式语义丢失或重复（期望 ${formulaCounts.displayRendered}，实际 ${renderedDisplayBlocks}）`);
  }
  if (formulaCounts && formulaCounts.displayFallback !== fallbackDisplayBlocks) {
    issues.push(`块公式降级状态不一致（期望 ${formulaCounts.displayFallback}，实际 ${fallbackDisplayBlocks}）`);
  }
  if (renderedMathTeX.length) issues.push("MathJax 公式中残留原始 TeX 命令");
  if (mathJaxSpacerNodes) issues.push(`MathJax CHTML 伸缩符号残留（${mathJaxSpacerNodes} 个 spacer 节点）`);
  if (rawTeXCommands.length) issues.push("正文中残留未渲染的 TeX 命令");
  if (rawInlineTeX.length) issues.push("正文中残留未渲染的 $…$ 行内公式");
  if (article.renderProfile === "scientific" && /\\begin\{|\$\$|\\\(/.test(unrenderedHtml)) issues.push("科学空间残留原始 TeX");
  const scientificChrome = /首页|数学研究|信息时代/.test(firstText)
    || /\bBy\s+.+?\|\s*\d{4}-\d{2}-\d{2}\b/i.test(firstText)
    || firstText.includes(entry.title);
  if (article.renderProfile === "scientific" && (/<h[1-6][^>]*>[^<]*#\s*<\/h/i.test(html) || scientificChrome)) {
    issues.push("科学空间页首元信息未清理");
  }
  const summaryStart = readerAuditSummaryLead(entry.summary);
  if (article.renderProfile === "scientific" && summaryStart.length >= 12 && !firstText.includes(summaryStart)) {
    issues.push("科学空间正文起点与卡片摘要不一致");
  }
  return {
    source: source.title,
    kind: source.kind,
    entry: entry.title,
    mode: article.contentMode || "article",
    profile: article.renderProfile,
    textLength: text.length,
    images: countMatches(html, /<img\b/gi),
    katexBlocks: countMatches(html, /class="katex-display"/gi),
    mathJaxBlocks: countMatches(html, /<mjx-container\b[^>]*display="true"/gi),
    mathJaxSpacerNodes: mathJaxSpacerNodes || undefined,
    formulaCounts,
    formulaDiagnostics: [...fallbackFormulae, ...formulaErrors].slice(0, 2).length
      ? [...fallbackFormulae, ...formulaErrors].slice(0, 2)
      : undefined,
    rawTeXDiagnostics: rawFormulaDiagnostics.length
      ? rawFormulaDiagnostics.map((formula) => formula.replace(/\s+/g, " ").slice(0, 220))
      : undefined,
    renderedMathDiagnostics: renderedMathTeX.length ? renderedMathTeX : undefined,
    issues
  };
}

export function expectedImageProxyDiagnostic(error: unknown): string | undefined {
  if (error instanceof UnsupportedReaderImageTypeError && error.contentType === "image/svg+xml") {
    return "首图为 SVG；正文保留直接图片显示，加载失败时不会绕过安全代理限制。";
  }
  if (error instanceof RobotsDisallowedError) {
    return "首图的本地失败回退受 robots.txt 限制；正文保留原始图片地址与安全原文入口。";
  }
  return undefined;
}

async function inspectFirstImage(http: PublicHttpClient, entry: Entry, article: ReaderArticle, result: ReaderAuditResult, signal?: AbortSignal): Promise<void> {
  const imageUrl = load(article.contentHtml)("img").first().attr("src");
  if (!imageUrl) return;
  try {
    // The data URL is held in memory only. This checks the same robots-aware
    // proxy used for a failed renderer image without retaining a copy.
    await http.getImageDataUrl(imageUrl, entry.url, { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
    // The renderer can safely use a remote SVG as an <img>, but the main
    // process deliberately refuses to turn un-sanitised SVG into a data URL.
    // That is an expected proxy exclusion rather than a broken article image.
    const diagnostic = expectedImageProxyDiagnostic(error);
    if (diagnostic) {
      result.imageDiagnostics = [...(result.imageDiagnostics || []), diagnostic];
      return;
    }
    result.issues.push(`首图本地代理失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Unlike a plain Promise.race, a deadline here first aborts the supplied
 * signal. ArticleReader propagates it into robots, Chromium fetch and its
 * offscreen BrowserWindow, so the next sample never waits behind abandoned
 * renderer/network work. The race still returns promptly if an injected test
 * double ignores cancellation.
 */
export async function runReaderAuditOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  onWaiting?: (elapsedMs: number) => void,
  heartbeatMs = DEFAULT_HEARTBEAT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new ReaderAuditTimeoutError(label, timeoutMs);
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      callback();
    };
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      finish(() => reject(timeoutError));
    }, timeoutMs);
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => onWaiting?.(Date.now() - startedAt), heartbeatMs);
    }
    operationPromise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(controller.signal.aborted ? timeoutError : error))
    );
  });
}

export type ReaderAuditSampleKind = "newest" | "historical" | "all";

type SourceSample = { source: Source; entry: Entry; sample: ReaderAuditSampleKind };

export function selectReaderAuditSamples(source: Source, available: Entry[], allEntries = false): SourceSample[] {
  if (!available.length) return [];
  if (allEntries) return available.map((entry) => ({ source, entry, sample: "all" }));
  const samples: SourceSample[] = [{ source, entry: available[0], sample: "newest" }];
  if (available.length > 1) {
    const index = Math.min(available.length - 1, 1 + source.id.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0) % (available.length - 1));
    samples.push({ source, entry: available[index], sample: "historical" });
  }
  return samples;
}

function sourceSamples(database: ReadingDatabase, source: Source, allEntries = false): SourceSample[] {
  const available = database.listEntries({ sourceId: source.id, limit: allEntries ? 10_000 : 200 });
  return selectReaderAuditSamples(source, available, allEntries);
}

async function reportProgress(options: ReaderAuditOptions, progress: ReaderAuditProgress): Promise<void> {
  const target = progress.entry ? `「${progress.source}」/「${progress.entry}」` : `「${progress.source}」`;
  const stage = progress.stage === "read" ? "读取正文" : progress.stage === "image" ? "检查首图" : progress.stage === "layout" ? "检查排版" : "";
  const elapsed = progress.elapsedMs === undefined ? "" : `，已用 ${Math.ceil(progress.elapsedMs / 1_000)} 秒`;
  const status = progress.status ? `，${progress.status}` : "";
  console.log(`[reader-audit] ${progress.completed}/${progress.total} ${progress.phase} ${target}${stage ? `，${stage}` : ""}${elapsed}${status}`);
  try {
    await options.onProgress?.(progress);
  } catch (error) {
    // Progress telemetry must never make a read-only audit fail. The final
    // result still prints to stdout even if its optional report path fails.
    console.warn(`[reader-audit] 写入进度失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function reportResult(options: ReaderAuditOptions, result: ReaderAuditResult): Promise<void> {
  try {
    await options.onResult?.(result);
  } catch (error) {
    console.warn(`[reader-audit] 写入中间结果失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/**
 * Opens the newest and one deterministic historical entry for every saved
 * source through the normal reader pipeline. It is intentionally read-only
 * and returns metrics, never article HTML, so it can be used for release or
 * regression checks safely without becoming a full-text archive.
 */
export async function auditLocalReader(databasePath: string, options: ReaderAuditOptions = {}): Promise<ReaderAuditResult[]> {
  const database = new ReadingDatabase(databasePath);
  const http = new PublicHttpClient();
  const renderer = new IsolatedPageRenderer();
  const zhihuFollow = new ZhihuFollowConnector();
  const reader = new ArticleReader(http, renderer, (url, options) => zhihuFollow.renderArticle(url, options));
  const results: ReaderAuditResult[] = [];
  try {
    const configuredSourceFilter = options.sourceFilter ?? process.env.READING_HUB_AUDIT_SOURCE;
    const sourceFilter = configuredSourceFilter?.trim().toLocaleLowerCase();
    const sources = database.listSources().filter((source) => !sourceFilter
      || source.id.toLocaleLowerCase() === sourceFilter
      || source.title.toLocaleLowerCase() === sourceFilter);
    if (sourceFilter && !sources.length) {
      const result: ReaderAuditResult = { source: configuredSourceFilter || "未知来源", kind: "generic", status: "skipped", issues: ["未找到指定来源"] };
      await reportResult(options, result);
      await reportProgress(options, { phase: "source_skipped", completed: 0, total: 0, source: result.source, kind: result.kind, status: result.status, issueCount: result.issues.length });
      return [result];
    }
    const allEntries = options.allEntries ?? process.env.READING_HUB_AUDIT_ALL === "1";
    const planned = sources.map((source) => ({ source, samples: sourceSamples(database, source, allEntries) }));
    const total = planned.reduce((count, item) => count + item.samples.length, 0);
    const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const imageTimeoutMs = options.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
    const layoutTimeoutMs = options.layoutTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
    const sampleDelayMs = options.sampleDelayMs ?? DEFAULT_SAMPLE_DELAY_MS;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let completed = 0;

    for (const { source, samples } of planned) {
      if (!samples.length) {
        const result: ReaderAuditResult = { source: source.title, kind: source.kind, status: "skipped", issues: ["没有可审计的文章"] };
        results.push(result);
        await reportResult(options, result);
        await reportProgress(options, { phase: "source_skipped", completed, total, source: source.title, kind: source.kind, status: result.status, issueCount: result.issues.length });
        continue;
      }
      for (const { entry, sample } of samples) {
        const startedAt = Date.now();
        await reportProgress(options, { phase: "started", completed, total, source: source.title, kind: source.kind, entry: entry.title, sample, stage: "read" });
        try {
          const article = await runReaderAuditOperation(
            (signal) => reader.read(entry, source, { signal }),
            readTimeoutMs,
            "正文读取",
            (elapsedMs) => void reportProgress(options, { phase: "waiting", completed, total, source: source.title, kind: source.kind, entry: entry.title, sample, stage: "read", elapsedMs }),
            heartbeatMs
          );
          const result = inspectArticle(source, entry, article);
          result.sample = sample;
          await reportProgress(options, { phase: "started", completed, total, source: source.title, kind: source.kind, entry: entry.title, sample, stage: "image" });
          await runReaderAuditOperation(
            (signal) => inspectFirstImage(http, entry, article, result, signal),
            imageTimeoutMs,
            "首图检查",
            (elapsedMs) => void reportProgress(options, { phase: "waiting", completed, total, source: source.title, kind: source.kind, entry: entry.title, sample, stage: "image", elapsedMs }),
            heartbeatMs
          );
          if (options.inspectLayout && hasDisplayFormula(article)) {
            await reportProgress(options, { phase: "started", completed, total, source: source.title, kind: source.kind, entry: entry.title, sample, stage: "layout" });
            const visualDiagnostics = await runReaderAuditOperation(
              () => Promise.resolve(options.inspectLayout?.(article, source, entry)),
              layoutTimeoutMs,
              "排版检查",
              (elapsedMs) => void reportProgress(options, { phase: "waiting", completed, total, source: source.title, kind: source.kind, entry: entry.title, sample, stage: "layout", elapsedMs }),
              heartbeatMs
            );
            if (visualDiagnostics?.length) {
              result.visualDiagnostics = visualDiagnostics.slice(0, 6);
              result.issues.push(`阅读器公式排版异常：${visualDiagnostics[0]}`);
            }
          }
          result.status = result.issues.length ? "issues" : "passed";
          result.durationMs = Date.now() - startedAt;
          results.push(result);
          await reportResult(options, result);
        } catch (error) {
          const timedOut = error instanceof ReaderAuditTimeoutError;
          if (error instanceof RobotsDisallowedError) {
            const result: ReaderAuditResult = { source: source.title, kind: source.kind, entry: entry.title, sample, mode: "embedded", status: "skipped", durationMs: Date.now() - startedAt, issues: [] };
            results.push(result);
            await reportResult(options, result);
          } else {
            const result: ReaderAuditResult = {
              source: source.title,
              kind: source.kind,
              entry: entry.title,
              sample,
              status: timedOut ? "timed_out" : "failed",
              durationMs: Date.now() - startedAt,
              issues: [error instanceof Error ? error.message : "读取失败"]
            };
            results.push(result);
            await reportResult(options, result);
          }
        }
        completed += 1;
        const result = results[results.length - 1];
        await reportProgress(options, {
          phase: "finished",
          completed,
          total,
          source: source.title,
          kind: source.kind,
          entry: entry.title,
          sample,
          elapsedMs: Date.now() - startedAt,
          status: result?.status,
          issueCount: result?.issues.length
        });
        // Stay polite to every source while exercising the same reader path.
        if (sampleDelayMs > 0) await sleep(sampleDelayMs);
      }
    }
  } finally {
    database.close();
  }
  return results;
}
