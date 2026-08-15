/**
 * `SourceKind` remains the small, user-facing compatibility layer used by the
 * existing UI. New integrations are selected through `connectorId`, rather
 * than adding more special cases to the scheduler.
 */
export type SourceKind = "rss" | "generic" | "manual" | "zhihu" | "zhihu_follow" | "x" | "academic";
export type SourceStatus = "active" | "needs_review" | "paused" | "error";
export type ConnectorId = SourceKind;
export type AccountStatus = "active" | "expired" | "revoked" | "error";

export interface ExtractionRule {
  version: 1;
  /** Internal revision used to perform one safe automatic rule audit. */
  autoRepairRevision?: number;
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
  kind: SourceKind;
  /** Built-in connector ID. It is explicit so future connectors are not tied to SourceKind branches. */
  connectorId?: ConnectorId;
  accountId?: string;
  config?: Record<string, unknown>;
  status: SourceStatus;
  extractionRule?: ExtractionRule;
  pollingEnabled: boolean;
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

/** Codex CLI exposes these bounded reasoning levels for its supported models. */
export type AiReasoningEffort = "low" | "medium" | "high" | "xhigh";

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
  article: AiArticleContext;
}

export interface AiAnswer {
  provider: AiProviderId;
  model: string;
  text: string;
}

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
  kind: SourceKind;
  connectorId?: ConnectorId;
  accountId?: string;
  config?: Record<string, unknown>;
  extractionRule?: ExtractionRule;
  pollingEnabled: boolean;
  status?: SourceStatus;
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
