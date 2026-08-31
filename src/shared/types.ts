/**
 * `SourceKind` remains the small, user-facing compatibility layer used by the
 * existing UI. New integrations are selected through `connectorId`, rather
 * than adding more special cases to the scheduler.
 */
export type SourceKind = "rss" | "generic" | "manual" | "zhihu" | "zhihu_follow" | "x" | "xiaohongshu" | "academic";
export type SourceStatus = "active" | "needs_review" | "paused" | "error";
/**
 * Connector IDs are host-owned opaque keys. `SourceKind` remains the compact
 * UI compatibility category; a future built-in connector need not force a
 * scheduler or database switch on every source kind.
 */
export type ConnectorId = string;
export type AccountStatus = "active" | "expired" | "revoked" | "error";

export interface ExtractionRule {
  version: 1;
  /** Internal revision used to perform one safe automatic rule audit. */
  autoRepairRevision?: number;
  /** Internal revision used to re-read published dates after parser upgrades. */
  publicationDateRevision?: number;
  /** Internal revision used to discover a declared Feed on older web sources. */
  feedDiscoveryRevision?: number;
  /** A public Feed declared by the source page and verified by the host. */
  feedUrl?: string;
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
  /** Public icon declared by the feed, retained as source metadata only. */
  iconUrl?: string;
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

/**
 * A provider-defined, stable label attached to a piece of content.
 *
 * `scheme` namespaces a provider's taxonomy so that unrelated labels such as
 * two different sites' “AI” categories are never accidentally merged. `key`
 * is the provider's stable category/tag id (often a slug) and `label` is the
 * user-facing text. The host records the source/origin relationship
 * separately; connectors therefore never need to know database IDs.
 */
export interface Facet {
  scheme: string;
  key: string;
  label: string;
}

/** Stable facet identity without presentation text, suitable for filtering. */
export type FacetReference = Pick<Facet, "scheme" | "key">;

/** A locally-queryable facet count for one source's content origins. */
export interface SourceFacet extends Facet {
  sourceId: string;
  entryCount: number;
}

export type SubscriptionHistoryMode = "none" | "selected" | "all";

/**
 * User-owned collection policy for one connector target.
 *
 * Empty `facetSelections` accepts all current items. Once categories are
 * selected, newly received content must match at least one selected facet;
 * history still defaults to `none`, so discovering a publisher archive can
 * never silently import its entire back catalogue.
 */
export interface SubscriptionScope {
  facetSelections: Facet[];
  history: {
    mode: SubscriptionHistoryMode;
    /** Optional bounded cap when a connector supports historical discovery. */
    limit?: number;
  };
}

/** Returned to source settings without exposing connector credentials. */
export interface SourceCollectionSettings {
  scope: SubscriptionScope;
  facets: SourceFacet[];
  /** Adapter capability metadata; absent only on persistence-only callers. */
  facetDiscoveryAvailable?: boolean;
  historyAvailable?: boolean;
}

/** Connector-provided, metadata-only taxonomy catalogue. */
export interface FacetCatalog {
  facets: Facet[];
  totalEntries?: number;
}

export interface RawEntry {
  url: string;
  title: string;
  author?: string;
  publishedAt?: number;
  summary?: string;
  imageUrl?: string;
  /**
   * Feed-supplied HTML used only while an already-subscribed Feed is being
   * opened in the reader. It is never written to SQLite or returned by the
   * database APIs.
   */
  feedContentHtml?: string;
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
  /**
   * Provider-declared categories/tags. They are persisted against this
   * source-origin, not as globally authoritative facts about the content.
   */
  facets?: Facet[];
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
  /** Match an entry that has at least one matching source-origin facet. */
  facetSelections?: FacetReference[];
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
  /** Facets declared by this exact provider origin. */
  facets?: Facet[];
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
  /** Always present; legacy subscriptions resolve to a feed-only default. */
  scope: SubscriptionScope;
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
  /** Public source icon discovered from the synchronised Feed, if provided. */
  iconUrl?: string;
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
  /** Optional metadata-only taxonomy discovery for the shared collection UI. */
  inspectFacets?(source: Source): Promise<FacetCatalog | undefined>;
  /** Whether this concrete source has an explicit, safely readable history catalogue. */
  supportsHistoricalCollection?(source: Source): boolean;
  sync(context: SyncContext): Promise<SyncResult>;
  normalize(item: RawEntry, source: Source): NormalizedEntry;
}

/**
 * Count-only formula ingestion diagnostics. They are deliberately transient:
 * no TeX, page HTML, credentials, or source URLs are retained here.
 */
export interface ReaderFormulaDiagnostics {
  total: number;
  semantic: number;
  mathJaxScript: number;
  mathJaxFrame: number;
  text: number;
  /** Formula records whose source semantics require block-level layout. */
  display: number;
  rendered: number;
  fallback: number;
  dropped: number;
  /** Display-specific accounting lets audits catch an inline/block semantic loss. */
  displayRendered: number;
  displayFallback: number;
  displayDropped: number;
  /**
   * Transient local renderer policy selected from FormulaDocument features.
   * It contains no source text and lets audits distinguish a simple KaTeX
   * article from a document-scoped MathJax article.
   */
  formulaRenderPolicy?: "standard" | "scientific-document";
}

/**
 * An author-declared native-language version of the current article.
 *
 * This is intentionally transient reader metadata: it is discovered from the
 * page's own alternate-language links and never becomes a subscription,
 * credential, or stored copy of the translated article.
 */
export interface ReaderLanguageVariant {
  /** Public URL that the main process has already approved for this article. */
  url: string;
  /** BCP 47 primary language tag where the publisher made it available. */
  language: string;
  /** A compact reader-facing label such as “English” or “中文”. */
  label: string;
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
  /**
   * A feed may provide an explicit body or a safe local summary even when the
   * original article cannot be read because its robots policy forbids
   * automated access.
   */
  contentMode?: "article" | "feed_body" | "feed_summary";
  /** Safe count-only telemetry used by the local reader audit. */
  formulaDiagnostics?: ReaderFormulaDiagnostics;
  /** Publisher-declared versions available for this article, including this page. */
  languageVariants?: ReaderLanguageVariant[];
  /** Primary language tag for the version currently rendered in this reader. */
  activeLanguage?: string;
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
  /**
   * Translation carries no article context at all. Explanation and free-form
   * questions carry the normal bounded article excerpt.
   */
  article?: AiArticleContext;
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
  /**
   * An author-linked, same-origin archive descriptor. It is discovery
   * metadata only: a new source remains Feed-only until the user explicitly
   * selects a history scope, at which point the archive is parsed and
   * validated. Article bodies are never fetched or persisted for this.
   */
  historicalArchiveUrl?: string;
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

export interface OpmlImportResult {
  cancelled: boolean;
  imported: number;
  existing: number;
  skipped: number;
}

/** A direct, user-supplied platform profile URL. */
export interface ProfileSubscriptionInput {
  url: string;
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
