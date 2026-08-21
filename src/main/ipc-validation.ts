import type {
  AiProviderConfiguration,
  AiProviderId,
  AiStreamRequest,
  EntryListQuery,
  ExtractionRule,
  ProfileSubscriptionInput,
  SourceKind,
  SourceSettings,
  SubscriptionDraft
} from "../shared/types";

const SOURCE_KINDS: SourceKind[] = ["rss", "generic", "manual", "zhihu", "zhihu_follow", "x", "xiaohongshu", "academic"];
const AI_PROVIDERS = ["openai", "deepseek", "codex-cli"] as const;
const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
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
  const startAt = numericTimestamp(value.startAt, "开始时间无效。");
  const endAt = numericTimestamp(value.endAt, "结束时间无效。");
  const limit = value.limit === undefined ? undefined : boundedInteger(value.limit, 1, 1_000, "文章数量限制无效。");
  if (startAt !== undefined && endAt !== undefined && startAt >= endAt) throw new Error("时间筛选范围无效。");
  return { sourceId, startAt, endAt, limit };
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

export function isAiStreamRequest(value: unknown): value is AiStreamRequest {
  if (!isRecord(value) || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value.requestId) || !isRecord(value.request)) return false;
  const request = value.request;
  const article = request.article;
  const selection = request.selection;
  return AI_PROVIDERS.includes(request.provider as typeof AI_PROVIDERS[number])
    && typeof request.question === "string"
    && request.question.length <= 3_000
    && isRecord(article)
    && typeof article.title === "string"
    && article.title.length <= 500
    && typeof article.url === "string"
    && article.url.length <= 2_000
    && typeof article.text === "string"
    && article.text.length <= 18_000
    && (selection === undefined || isRecord(selection)
      && typeof selection.text === "string"
      && selection.text.length <= 2_000
      && ["translate", "explain", "ask"].includes(selection.intent as string));
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
