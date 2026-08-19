/**
 * `SourceKind` remains the small, user-facing compatibility layer used by the
 * existing UI. New integrations are selected through `connectorId`, rather
 * than adding more special cases to the scheduler.
 */
export type SourceKind = "rss" | "generic" | "manual" | "zhihu" | "zhihu_follow" | "x" | "academic";
export type SourceStatus = "active" | "needs_review" | "paused" | "error";
export type ConnectorId = SourceKind;
export type AccountStatus = "active" | "expired" | "revoked" | "error";
/** A public RSSHub route supplied by the reader; it never carries credentials. */
export type RssHubPlatform = "x" | "xiaohongshu";

export interface ExtractionRule {
  version: 1;
  /** Internal revision used to perform one safe automatic rule audit. */
  autoRepairRevision?: number;
  /** Internal revision used to re-read published dates after parser upgrades. */
  publicationDateRevision?: number;
  itemRootSelector?: string;
  titleSelector?: string;
  timeSelector?: string;
  authorSelector?: string;
  imageSelector?: string;
  summarySelector?: string;
  rendererRequired?: boolean;
}

export interface Source {
  id: string;
  url: string;
  title: string;
  /** A reader-owned local folder label. It never changes a connector or remote subscription. */
  category?: string;
  kind: SourceKind;
  /** Built-in connector ID. It is explicit so future connectors are not tied to SourceKind branches. */
  connectorId?: ConnectorId;
  accountId?: string;
  config?: Record<string, unknown>;
  /** Internal connector metadata schema revision; never user-configurable. */
  metadataRevision?: number;
  status: SourceStatus;
  extractionRule?: ExtractionRule;
  pollingEnabled: boolean;
  /** Requested cadence in minutes. Undefined retains the conservative 30–60 minute default. */
  refreshIntervalMinutes?: number;
  etag?: string;
  lastModified?: string;
  lastCheckedAt?: number;
  nextCheckAt?: number;
  consecutiveEmpty: number;
  failureCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RawEntry {
  url: string;
  title: string;
  author?: string;
  publishedAt?: number;
  summary?: string;
  imageUrl?: string;
  /** Provider-stable object id, never shown to the reader. */
  externalId?: string;
  /** DOI, arXiv id, canonical URL, or provider id used for cross-provider grouping. */
  canonicalIdentity?: string;
  /** When a connector first observed an item; distinct from publication time. */
  observedAt?: number;
  providerId?: ConnectorId;
  /** Human-readable provenance such as OpenAlex or ORCID. */
  providerLabel?: string;
  externalUrl?: string;
}

export interface Entry extends RawEntry {
  id: string;
  sourceId: string;
  canonicalUrl: string;
  contentHash: string;
  read: boolean;
  favorite: boolean;
  createdAt: number;
  observedAt?: number;
  providerId?: ConnectorId;
  externalId?: string;
  canonicalIdentity?: string;
  providerLabel?: string;
  origins?: ContentOrigin[];
}

/**
 * Timeline query options. `endAt` is exclusive so a selected end date can
 * safely include the entire local calendar day without relying on 23:59:59.
 */
export interface EntryListQuery {
  sourceId?: string;
  startAt?: number;
  endAt?: number;
  /** Omit the limit for an explicitly bounded time-range query. */
  limit?: number;
}

/** Small local navigation counters; no article body or remote data is involved. */
export interface LibraryCounts {
  unread: number;
  favorite: number;
  today: number;
}

export interface ContentOrigin {
  sourceId: string;
  providerId: ConnectorId;
  providerLabel?: string;
  externalId?: string;
  originalUrl: string;
  observedAt: number;
}

/** A locally authorised provider account. Secret values are only keychain references. */
export interface Account {
  id: string;
  connectorId: ConnectorId;
  displayName: string;
  subjectId?: string;
  keychainAccount?: string;
  scopes: string[];
  status: AccountStatus;
  config?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** A connector target. Existing sources have a one-to-one compatibility subscription. */
export interface Subscription {
  id: string;
  sourceId: string;
  connectorId: ConnectorId;
  accountId?: string;
  targetId?: string;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SyncCheckpoint {
  subscriptionId: string;
  cursor?: string;
  sinceId?: string;
  data?: Record<string, unknown>;
  updatedAt: number;
}

export interface ConnectorManifest {
  id: ConnectorId;
  version: 1;
  displayName: string;
  builtIn: true;
  capabilities: Array<"public-http" | "oauth" | "author-search">;
  requiresAccount?: boolean;
  allowedHosts: string[];
}

export interface AuthorizationContext {
  redirectUri?: string;
}

export interface DiscoveryContext {
  account?: Account;
}

export interface SubscriptionDraft {
  title: string;
  targetId?: string;
  config?: Record<string, unknown>;
}

export interface SyncContext {
  source: Source;
  subscription: Subscription;
  account?: Account;
  checkpoint?: SyncCheckpoint;
}

export interface SyncResult {
  entries: RawEntry[];
  checkpoint?: Omit<SyncCheckpoint, "subscriptionId" | "updatedAt">;
  /** A successful response without new entries must not be treated as a broken extractor. */
  emptyIsHealthy?: boolean;
  notModified?: boolean;
  etag?: string;
  lastModified?: string;
  extractionRule?: ExtractionRule;
  /** Persisted by the host after a connector has replayed upgraded metadata. */
  metadataRevision?: number;
}

export type NormalizedEntry = Entry;

/**
 * A deliberately narrow extension boundary. Connectors never receive SQLite,
 * keychain, renderer, or unrestricted network access; the host owns those.
 */
export interface ConnectorAdapter {
  manifest: ConnectorManifest;
  authorize?(context: AuthorizationContext): Promise<Account>;
  discover?(input: string, context: DiscoveryContext): Promise<SubscriptionDraft[]>;
  sync(context: SyncContext): Promise<SyncResult>;
  normalize(item: RawEntry, source: Source): NormalizedEntry;
}

/** A transient, sanitised article document shown only inside the local reader. */
export interface ReaderArticle {
  entryId: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: number;
  coverImageUrl?: string;
  /** Rendering mode is chosen locally from the URL and document structure. */
  renderProfile: ReaderRenderProfile;
  contentHtml: string;
}

export type ReaderRenderProfile = "standard" | "scientific";

/** AI providers supported by the local reading assistant. */
export type AiProviderId = "openai" | "deepseek" | "codex-cli";

/** The built-in selector only presents verified Codex model identifiers. */
export const CODEX_CLI_MODEL_OPTIONS = [
  { id: "default", label: "跟随 Codex CLI 默认模型" },
  { id: "gpt-5.6", label: "GPT-5.6 Sol（推荐）" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol（固定版本）" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra（均衡）" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna（更快、更省）" }
] as const;

export type CodexCliModelId = (typeof CODEX_CLI_MODEL_OPTIONS)[number]["id"];

/** Codex CLI exposes these bounded reasoning levels for its supported models. */
export type AiReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Non-secret provider state exposed to the renderer. */
export interface AiProviderSettings {
  id: AiProviderId;
  label: string;
  model: string;
  /** Present for providers whose local execution supports a reasoning dial. */
  effort?: AiReasoningEffort;
  configured: boolean;
  /** API providers require a Keychain-backed key; local Codex CLI does not. */
  requiresApiKey: boolean;
  /** Safe, non-secret availability guidance for the provider selector. */
  availabilityMessage?: string;
}

/** API key input stays in the renderer only long enough to enter Keychain. */
export interface AiProviderConfiguration {
  provider: AiProviderId;
  apiKey?: string;
  model?: string;
  effort?: AiReasoningEffort;
}

/** Plain, size-bounded article context sent to an explicitly selected AI provider. */
export interface AiArticleContext {
  title: string;
  url: string;
  sourceTitle?: string;
  text: string;
}

export interface AiQuestionRequest {
  provider: AiProviderId;
  question: string;
  /** Present only after the reader deliberately invokes an action on selected article text. */
  selection?: AiSelectionContext;
  article: AiArticleContext;
}

export type AiSelectionIntent = "translate" | "explain" | "ask";

/** A bounded, user-selected excerpt interpreted against the accompanying article context. */
export interface AiSelectionContext {
  text: string;
  intent: AiSelectionIntent;
}

export interface AiAnswer {
  provider: AiProviderId;
  model: string;
  text: string;
}

/** A renderer-generated id makes streamed IPC events race-free. */
export interface AiStreamRequest {
  requestId: string;
  request: AiQuestionRequest;
}

/** Safe, one-way updates emitted by the main process for an AI answer. */
export type AiStreamEvent =
  | { type: "delta"; requestId: string; text: string }
  | { type: "complete"; requestId: string; answer: AiAnswer }
  | { type: "error"; requestId: string; message: string };

/** Result of opening an entry in the app. Some sites forbid automated extraction. */
export type ArticleReadResult =
  | { kind: "article"; article: ReaderArticle }
  | { kind: "embedded" };

export interface ProbeResult {
  kind: SourceKind;
  title: string;
  url: string;
  confidence: number;
  extractionRule?: ExtractionRule;
  preview: RawEntry[];
  requiresReview: boolean;
  message?: string;
}

export interface CalibrationCandidate {
  label: string;
  rule: ExtractionRule;
  preview: RawEntry[];
  confidence: number;
}

export interface CalibrationResult {
  title: string;
  url: string;
  candidates: CalibrationCandidate[];
  message?: string;
}

export interface Connector {
  probe(url: string): Promise<ProbeResult>;
  fetch(source: Source): Promise<RawEntry[]>;
  normalize(item: RawEntry, source: Source): Entry;
}

export interface SourceInput {
  url: string;
  title: string;
  category?: string;
  kind: SourceKind;
  connectorId?: ConnectorId;
  accountId?: string;
  config?: Record<string, unknown>;
  extractionRule?: ExtractionRule;
  pollingEnabled: boolean;
  refreshIntervalMinutes?: number;
  status?: SourceStatus;
}

/**
 * RSSHub remains an external Feed producer. Reading Hub only accepts a public
 * route URL and treats its output exactly like any other RSS/Atom/JSON Feed.
 */
export interface RssHubSubscriptionInput {
  url: string;
  platform: RssHubPlatform;
  /** Local-only display name. */
  title?: string;
}

/** User-editable metadata for an existing source. Secrets and connector accounts stay out of this surface. */
export interface SourceSettings {
  title: string;
  category?: string;
  kind: SourceKind;
  pollingEnabled: boolean;
  refreshIntervalMinutes?: number;
}

export interface Followee {
  urlToken: string;
  fullname: string;
  url: string;
  avatarUrl?: string;
  headline?: string;
  followerCount?: number;
  updatedAt: number;
}
