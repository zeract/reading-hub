import { load } from "cheerio";
import { ArticleReader } from "./article-reader";
import { ReadingDatabase } from "./database";
import { PublicHttpClient } from "./http";
import { IsolatedPageRenderer } from "./page-renderer";
import { RobotsDisallowedError } from "./robots";
import { ZhihuFollowConnector } from "./zhihu-follow";
import type { Entry, ReaderArticle, Source } from "../shared/types";

export type ReaderAuditResult = {
  source: string;
  kind: Source["kind"];
  entry?: string;
  profile?: ReaderArticle["renderProfile"];
  textLength?: number;
  images?: number;
  katexBlocks?: number;
  mathJaxBlocks?: number;
  mathJaxSpacerNodes?: number;
  formulaDiagnostics?: string[];
  rawTeXDiagnostics?: string[];
  renderedMathDiagnostics?: string[];
  mode?: "article" | "embedded";
  sample?: "newest" | "historical";
  issues: string[];
};

function plainText(html: string): string {
  return load(html).text().replace(/\s+/g, " ").trim();
}

function countMatches(value: string, expression: RegExp): number {
  return [...value.matchAll(expression)].length;
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
  const rawInlineTeX = plainText(unrenderedHtml).match(/(?<!\\)\$[^$\r\n]+\$/g) || [];
  const rawFormulaDiagnostics = [...rawTeXCommands, ...rawInlineTeX].slice(0, 2);
  const issues: string[] = [];
  // Follow-feed cards can legitimately be a short public status update rather
  // than a long-form article. Their in-app display is still valid.
  if (text.length < 180 && source.kind !== "zhihu_follow") issues.push("正文过短");
  const sanitised = load(`<article id="audit-sanitised">${html}</article>`);
  const executableElement = sanitised("script, iframe, object, embed").length > 0 || sanitised("#audit-sanitised *").toArray().some((node: any) => {
    const attributes = node.attribs || {};
    return Object.entries(attributes).some(([name, value]) => /^on/i.test(name)
      || ((name.toLowerCase() === "href" || name.toLowerCase() === "src") && /^\s*javascript:/i.test(String(value))));
  });
  if (executableElement) issues.push("净化失败：发现可执行标记");
  if (/READING_HUB_MATH|<mjx-merror\b|katex-error/i.test(html)) issues.push("公式渲染失败或残留占位符");
  if (formulaFallbacks) issues.push(`公式降级为原始 TeX 卡片（${formulaFallbacks} 处）`);
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
  const summaryStart = plainText(entry.summary || "").slice(0, 28);
  if (article.renderProfile === "scientific" && summaryStart.length >= 12 && !firstText.includes(summaryStart)) {
    issues.push("科学空间正文起点与卡片摘要不一致");
  }
  return {
    source: source.title,
    kind: source.kind,
    entry: entry.title,
    profile: article.renderProfile,
    textLength: text.length,
    images: countMatches(html, /<img\b/gi),
    katexBlocks: countMatches(html, /class="katex-display"/gi),
    mathJaxBlocks: countMatches(html, /<mjx-container\b[^>]*display="true"/gi),
    mathJaxSpacerNodes: mathJaxSpacerNodes || undefined,
    formulaDiagnostics: fallbackFormulae.length ? fallbackFormulae : undefined,
    rawTeXDiagnostics: rawFormulaDiagnostics.length ? rawFormulaDiagnostics : undefined,
    renderedMathDiagnostics: renderedMathTeX.length ? renderedMathTeX : undefined,
    issues
  };
}

async function inspectFirstImage(http: PublicHttpClient, entry: Entry, article: ReaderArticle, result: ReaderAuditResult): Promise<void> {
  const imageUrl = load(article.contentHtml)("img").first().attr("src");
  if (!imageUrl) return;
  try {
    // The data URL is held in memory only. This checks the same robots-aware
    // proxy used for a failed renderer image without retaining a copy.
    await http.getImageDataUrl(imageUrl, entry.url);
  } catch (error) {
    result.issues.push(`首图本地代理失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withAuditTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时，已跳过。`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Opens the newest and one deterministic historical entry for every saved
 * source through the normal reader pipeline. It is intentionally read-only
 * and returns metrics, never article HTML, so it can be used for release or
 * regression checks safely without becoming a full-text archive.
 */
export async function auditLocalReader(databasePath: string): Promise<ReaderAuditResult[]> {
  const database = new ReadingDatabase(databasePath);
  const http = new PublicHttpClient();
  const renderer = new IsolatedPageRenderer();
  const zhihuFollow = new ZhihuFollowConnector();
  const reader = new ArticleReader(http, renderer, (url) => zhihuFollow.renderArticle(url));
  const results: ReaderAuditResult[] = [];
  try {
    const sourceFilter = process.env.READING_HUB_AUDIT_SOURCE?.trim().toLocaleLowerCase();
    const sources = database.listSources().filter((source) => !sourceFilter
      || source.id.toLocaleLowerCase() === sourceFilter
      || source.title.toLocaleLowerCase() === sourceFilter);
    if (sourceFilter && !sources.length) {
      return [{ source: process.env.READING_HUB_AUDIT_SOURCE || "未知来源", kind: "generic", issues: ["未找到指定来源"] }];
    }
    for (const source of sources) {
      const available = database.listEntries(source.id, 200);
      if (!available.length) {
        results.push({ source: source.title, kind: source.kind, issues: ["没有可审计的文章"] });
        continue;
      }
      const samples: Array<{ entry: Entry; sample: "newest" | "historical" }> = [{ entry: available[0], sample: "newest" }];
      if (available.length > 1) {
        const index = Math.min(available.length - 1, 1 + source.id.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0) % (available.length - 1));
        samples.push({ entry: available[index], sample: "historical" as const });
      }
      for (const { entry, sample } of samples) {
        try {
          const article = await withAuditTimeout(reader.read(entry, source), 45_000, "正文读取");
          const result = inspectArticle(source, entry, article);
          result.sample = sample;
          await withAuditTimeout(inspectFirstImage(http, entry, article, result), 25_000, "首图检查");
          results.push(result);
        } catch (error) {
          if (error instanceof RobotsDisallowedError) {
            results.push({ source: source.title, kind: source.kind, entry: entry.title, sample, mode: "embedded", issues: [] });
          } else {
            results.push({
              source: source.title,
              kind: source.kind,
              entry: entry.title,
              sample,
              issues: [error instanceof Error ? error.message : "读取失败"]
            });
          }
        }
        // Stay polite to every source while exercising the same reader path.
        await sleep(400);
      }
    }
  } finally {
    database.close();
  }
  return results;
}
