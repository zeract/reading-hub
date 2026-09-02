import type {
  AiArticleContext,
  AiProviderConfiguration,
  AiProviderId,
  AiQuestionRequest,
  AiSelectionContext,
  AiStreamRequest,
  EntryPageCursor,
  EntryPageQuery,
  EntryListQuery,
  ExtractionRule,
  SubscriptionScope,
  ProfileSubscriptionInput,
  SourceKind,
  SourceSettings,
  SubscriptionDraft
} from "../shared/types";
import { normaliseFacet, normaliseFacetReference, normaliseSubscriptionScope } from "../shared/subscription-scope";
import {
  AI_STREAM_REQUEST_ID_PATTERN,
  MAX_AI_ARTICLE_MARKDOWN_LENGTH,
  MAX_AI_ARTICLE_TEXT_LENGTH,
  MAX_AI_ARTICLE_TITLE_LENGTH,
  MAX_AI_ARTICLE_URL_LENGTH,
  MAX_AI_QUESTION_LENGTH,
  MAX_AI_SELECTION_TEXT_LENGTH,
  MAX_AI_SOURCE_TITLE_LENGTH
} from "../shared/ai-input";

const SOURCE_KINDS: SourceKind[] = ["rss", "generic", "manual", "zhihu", "zhihu_follow", "x", "xiaohongshu", "academic"];
const AI_PROVIDERS = ["openai", "deepseek", "codex-cli"] as const;
const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const AI_REQUEST_TASKS = ["answer", "article-translation"] as const;
const AI_TRANSLATION_TARGETS = ["zh", "en"] as const;
const REFRESH_INTERVALS = [30, 60, 120, 240, 720, 1440];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, message: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(message);
  return value;
}

/** Validates text received through IPC before it reaches a service boundary. */
export function requireText(value: unknown, message = "请求文本无效。", maximum = 4_000): string {
  return requiredString(value, message, maximum);
}

function optionalString(value: unknown, message: string, maximum = 4_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new Error(message);
  return value;
}

/** IDs are opaque database keys, never arbitrary SQL or URL input. */
export function requireEntityId(value: unknown, message = "请求的项目无效，请刷新后重试。"): string {
  return requiredString(value, message, 160);
}

export function requireBoolean(value: unknown, message = "请求参数无效。"): boolean {
  if (typeof value !== "boolean") throw new Error(message);
  return value;
}

export function parseEntryListQuery(value: unknown): EntryListQuery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("文章列表筛选参数无效。");
  const sourceId = value.sourceId === undefined ? undefined : requireEntityId(value.sourceId, "来源筛选无效。");
  const search = value.search === undefined
    ? undefined
    : optionalString(value.search, "关键词搜索无效。", 160)?.trim().replace(/\s+/gu, " ");
  const startAt = numericTimestamp(value.startAt, "开始时间无效。");
  const endAt = numericTimestamp(value.endAt, "结束时间无效。");
  const limit = value.limit === undefined ? undefined : boundedInteger(value.limit, 1, 1_000, "文章数量限制无效。");
  const read = value.read === undefined ? undefined : requireBoolean(value.read, "已读筛选无效。");
  const favorite = value.favorite === undefined ? undefined : requireBoolean(value.favorite, "收藏筛选无效。");
  const facetSelections = value.facetSelections === undefined ? undefined : parseFacetReferences(value.facetSelections, "文章分类筛选无效。");
  if (startAt !== undefined && endAt !== undefined && startAt >= endAt) throw new Error("时间筛选范围无效。");
  if (search && !sourceId) throw new Error("请先选择一个来源再搜索。");
  return {
    sourceId,
    ...(search ? { search } : {}),
    startAt,
    endAt,
    limit,
    ...(read === undefined ? {} : { read }),
    ...(favorite === undefined ? {} : { favorite }),
    ...(facetSelections === undefined ? {} : { facetSelections })
  };
}

/** Validate a renderer cursor before it can become part of a keyset query. */
export function parseEntryPageQuery(value: unknown): EntryPageQuery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("文章分页参数无效。");
  const parsedBase = parseEntryListQuery({
    sourceId: value.sourceId,
    search: value.search,
    startAt: value.startAt,
    endAt: value.endAt,
    read: value.read,
    favorite: value.favorite,
    facetSelections: value.facetSelections
  }) ?? {};
  // A page endpoint owns its bounded size; never let the legacy unbounded
  // list limit slip through this IPC surface.
  const { limit: _ignoredLegacyLimit, ...base } = parsedBase;
  const pageSize = value.pageSize === undefined ? undefined : boundedInteger(value.pageSize, 1, 200, "文章分页大小无效。");
  const cursor = value.cursor === undefined ? undefined : parseEntryPageCursor(value.cursor);
  return { ...base, ...(pageSize === undefined ? {} : { pageSize }), ...(cursor === undefined ? {} : { cursor }) };
}

function parseEntryPageCursor(value: unknown): EntryPageCursor {
  if (!isRecord(value)) throw new Error("文章分页游标无效，请重新载入列表。");
  const publishedAt = value.publishedAt === undefined ? undefined : numericTimestamp(value.publishedAt, "文章分页游标无效，请重新载入列表。");
  const observedAt = numericTimestamp(value.observedAt, "文章分页游标无效，请重新载入列表。");
  const createdAt = numericTimestamp(value.createdAt, "文章分页游标无效，请重新载入列表。");
  const id = requireEntityId(value.id, "文章分页游标无效，请重新载入列表。");
  if (observedAt === undefined || createdAt === undefined) throw new Error("文章分页游标无效，请重新载入列表。");
  return { ...(publishedAt === undefined ? {} : { publishedAt }), observedAt, createdAt, id };
}

/** Validate the renderer-owned collection policy before it reaches SQLite. */
export function parseSubscriptionScope(value: unknown): SubscriptionScope {
  if (!isRecord(value) || !Array.isArray(value.facetSelections) || !isRecord(value.history)) {
    throw new Error("收集范围设置无效，请重新打开来源设置。");
  }
  if (value.facetSelections.length > 64) throw new Error("最多选择 64 个文章分类。");
  const facets = value.facetSelections.map((facet) => {
    const parsed = normaliseFacet(facet);
    if (!parsed) throw new Error("收集范围包含无效分类。");
    return parsed;
  });
  const mode = value.history.mode;
  if (mode !== "none" && mode !== "selected" && mode !== "all") throw new Error("历史收集方式无效。");
  const limit = value.history.limit === undefined
    ? undefined
    : boundedInteger(value.history.limit, 1, 10_000, "历史文章数量无效。");
  const scope = normaliseSubscriptionScope({
    facetSelections: facets,
    history: { mode, ...(limit === undefined ? {} : { limit }) }
  });
  if (scope.history.mode === "selected" && !scope.facetSelections.length) {
    throw new Error("按分类补充历史前，请至少选择一个文章分类。");
  }
  if (scope.history.mode === "all" && scope.facetSelections.length) {
    throw new Error("补充全部历史时不能同时筛选文章分类。");
  }
  return scope;
}

function parseFacetReferences(value: unknown, message: string): NonNullable<EntryListQuery["facetSelections"]> {
  if (!Array.isArray(value) || value.length > 64) throw new Error(message);
  const references = new Map<string, NonNullable<EntryListQuery["facetSelections"]>[number]>();
  for (const item of value) {
    const parsed = normaliseFacetReference(item);
    if (!parsed) throw new Error(message);
    references.set(`${parsed.scheme}\u0000${parsed.key}`, parsed);
  }
  return [...references.values()];
}

export function parseSourceSettings(value: unknown): SourceSettings {
  if (!isRecord(value)) throw new Error("来源设置无效。");
  const title = requiredString(value.title, "来源名称无效。", 120);
  const category = optionalString(value.category, "来源分类无效。", 60);
  if (!SOURCE_KINDS.includes(value.kind as SourceKind)) throw new Error("来源类型无效。");
  const pollingEnabled = requireBoolean(value.pollingEnabled, "自动刷新设置无效。");
  const refreshIntervalMinutes = value.refreshIntervalMinutes === undefined
    ? undefined
    : boundedInteger(value.refreshIntervalMinutes, 1, 1_440, "刷新时间无效。");
  if (refreshIntervalMinutes !== undefined && !REFRESH_INTERVALS.includes(refreshIntervalMinutes)) throw new Error("刷新时间无效。");
  return { title, category, kind: value.kind as SourceKind, pollingEnabled, refreshIntervalMinutes };
}

export function parseExtractionRule(value: unknown): ExtractionRule {
  if (!isRecord(value) || value.version !== 1) throw new Error("提取规则无效，请重新校准。");
  const output: ExtractionRule = { version: 1 };
  for (const key of ["feedUrl", "itemRootSelector", "titleSelector", "timeSelector", "authorSelector", "imageSelector", "summarySelector"] as const) {
    const parsed = optionalString(value[key], "提取规则包含无效字段。", 2_000);
    if (parsed !== undefined) output[key] = parsed;
  }
  for (const key of ["autoRepairRevision", "publicationDateRevision", "feedDiscoveryRevision"] as const) {
    const parsed = value[key] === undefined ? undefined : boundedInteger(value[key], 0, 1_000, "提取规则版本无效。");
    if (parsed !== undefined) output[key] = parsed;
  }
  if (value.rendererRequired !== undefined) output.rendererRequired = requireBoolean(value.rendererRequired, "渲染设置无效。");
  return output;
}

export function parseProfileSubscriptionInput(value: unknown): ProfileSubscriptionInput {
  if (!isRecord(value)) throw new Error("博主主页参数无效，请重新填写。");
  return {
    url: requiredString(value.url, "博主主页地址无效，请重新填写。", 2_000),
    title: optionalString(value.title, "来源名称无效。", 120)
  };
}

export function parseAcademicDraft(value: unknown): SubscriptionDraft {
  if (!isRecord(value)) throw new Error("学术作者参数无效，请重新搜索并选择。");
  const config = value.config;
  if (config !== undefined && !isRecord(config)) throw new Error("学术作者配置无效。");
  return {
    title: requiredString(value.title, "学术作者名称无效。", 160),
    targetId: optionalString(value.targetId, "学术作者标识无效。", 500),
    config: config ? { ...config } : undefined
  };
}

export function parseAiProviderConfiguration(value: unknown): AiProviderConfiguration {
  if (!isRecord(value) || !AI_PROVIDERS.includes(value.provider as typeof AI_PROVIDERS[number])) throw new Error("AI 服务配置无效。");
  const apiKey = optionalString(value.apiKey, "AI 密钥格式无效。", 1_000);
  const model = optionalString(value.model, "AI 模型名称无效。", 160);
  const effort = value.effort === undefined ? undefined : value.effort;
  if (effort !== undefined && !AI_EFFORTS.includes(effort as typeof AI_EFFORTS[number])) throw new Error("推理强度无效。");
  return { provider: value.provider as AiProviderConfiguration["provider"], apiKey, model, effort: effort as AiProviderConfiguration["effort"] };
}

export function parseAiProviderId(value: unknown): AiProviderId {
  if (!AI_PROVIDERS.includes(value as typeof AI_PROVIDERS[number])) throw new Error("AI 服务无效。");
  return value as AiProviderId;
}

export function parseAiStreamRequest(value: unknown): AiStreamRequest {
  if (!isRecord(value)) throw new Error("AI 流式请求结构无效，请刷新后重试。");
  if (typeof value.requestId !== "string" || !AI_STREAM_REQUEST_ID_PATTERN.test(value.requestId)) throw new Error("AI 请求标识无效，请重试。");
  if (!isRecord(value.request)) throw new Error("AI 学习请求无效，请重新发送问题。");
  const request = value.request;
  const article = request.article;
  const selection = request.selection;
  const task = request.task;
  const translationTarget = request.translationTarget;
  if (!AI_PROVIDERS.includes(request.provider as typeof AI_PROVIDERS[number])) throw new Error("AI 服务无效，请重新选择。");
  if (typeof request.question !== "string") throw new Error("AI 问题无效，请重新输入。");
  if (request.question.length > MAX_AI_QUESTION_LENGTH) throw new Error("问题过长，请控制在 3,000 个字符以内。");
  if (task !== undefined && !AI_REQUEST_TASKS.includes(task as typeof AI_REQUEST_TASKS[number])) {
    throw new Error("AI 任务无效，请刷新文章后重试。");
  }
  if (translationTarget !== undefined && !AI_TRANSLATION_TARGETS.includes(translationTarget as typeof AI_TRANSLATION_TARGETS[number])) {
    throw new Error("全文翻译语言无效，请重新选择。");
  }
  if (selection !== undefined) {
    if (!isRecord(selection) || typeof selection.text !== "string" || selection.text.length > MAX_AI_SELECTION_TEXT_LENGTH
      || !["translate", "explain", "ask"].includes(selection.intent as string)) {
      throw new Error("所选文字请求无效，请重新选择文章内容。");
    }
  }
  const parsedSelection: AiSelectionContext | undefined = selection === undefined
    ? undefined
    : { text: selection.text as string, intent: selection.intent as AiSelectionContext["intent"] };
  const isArticleTranslation = task === "article-translation";
  if (isArticleTranslation && parsedSelection) {
    throw new Error("全文翻译不应包含所选文字，请重新打开文章后重试。");
  }
  if (isArticleTranslation && translationTarget === undefined) {
    throw new Error("请选择全文翻译语言后重试。");
  }
  if (!isArticleTranslation && translationTarget !== undefined) {
    throw new Error("全文翻译语言只能用于全文翻译任务。");
  }
  const parsedArticle = isArticleTranslation
    ? parseArticleTranslationContext(article)
    : parsedSelection?.intent === "translate"
      ? parseSelectedTextTranslationPayload(article)
      : parseRequiredAiArticleContext(article);
  const parsedRequest: AiQuestionRequest = {
    provider: request.provider as AiProviderId,
    question: request.question as string,
    ...(task === undefined ? {} : { task: task as AiQuestionRequest["task"] }),
    ...(translationTarget === undefined ? {} : { translationTarget: translationTarget as AiQuestionRequest["translationTarget"] }),
    ...(parsedArticle ? { article: parsedArticle } : {}),
    ...(parsedSelection ? { selection: parsedSelection } : {})
  };
  return { requestId: value.requestId, request: parsedRequest };
}

/**
 * Selected-text translation is purposefully context-free. Rejecting any
 * article field catches renderer regressions before an external provider sees
 * it. Full-article translation uses the explicit task branch above instead.
 */
function parseSelectedTextTranslationPayload(article: unknown): undefined {
  if (article !== undefined) throw new Error("翻译请求不应包含文章上下文，请刷新文章后重试。");
  return undefined;
}

function parseArticleTranslationContext(article: unknown): AiArticleContext {
  const parsed = parseRequiredAiArticleContext(article);
  if (!parsed.translationMarkdown) throw new Error("全文翻译正文无效，请刷新文章后重试。");
  return parsed;
}

function parseRequiredAiArticleContext(article: unknown): AiArticleContext {
  if (!isRecord(article)) throw new Error("AI 文章上下文无效，请刷新文章后重试。");
  if (typeof article.title !== "string" || article.title.length > MAX_AI_ARTICLE_TITLE_LENGTH) throw new Error("AI 文章标题无效，请刷新文章后重试。");
  if (typeof article.url !== "string" || article.url.length > MAX_AI_ARTICLE_URL_LENGTH) throw new Error("AI 文章链接无效，请刷新文章后重试。");
  if (typeof article.text !== "string") throw new Error("AI 文章正文无效，请刷新文章后重试。");
  if (article.text.length > MAX_AI_ARTICLE_TEXT_LENGTH) throw new Error("文章上下文超过 18,000 个字符。请刷新页面后重试。");
  if (article.sourceTitle !== undefined && (typeof article.sourceTitle !== "string" || article.sourceTitle.length > MAX_AI_SOURCE_TITLE_LENGTH)) {
    throw new Error("AI 文章来源无效，请刷新文章后重试。");
  }
  if (article.translationMarkdown !== undefined && (typeof article.translationMarkdown !== "string" || article.translationMarkdown.length > MAX_AI_ARTICLE_MARKDOWN_LENGTH)) {
    throw new Error("全文翻译正文超过 18,000 个字符，请刷新文章后重试。");
  }
  return {
    title: article.title,
    url: article.url,
    text: article.text,
    ...(article.sourceTitle === undefined ? {} : { sourceTitle: article.sourceTitle }),
    ...(article.translationMarkdown === undefined ? {} : { translationMarkdown: article.translationMarkdown })
  };
}

function numericTimestamp(value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error(message);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, message: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(message);
  return value;
}
