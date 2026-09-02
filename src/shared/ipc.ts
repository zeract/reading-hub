import type {
  AiProviderConfiguration,
  AiProviderId,
  AiProviderSettings,
  AiStreamEvent,
  AiStreamRequest,
  ArticleReadResult,
  CalibrationResult,
  EntryPage,
  EntryPageQuery,
  LibraryCounts,
  OpmlImportResult,
  ProbeResult,
  ProfileSubscriptionInput,
  ReaderArticle,
  Source,
  SourceCollectionSettings,
  SourceFacet,
  SourceSettings,
  SubscriptionDraft,
  SubscriptionScope
} from "./types";

/**
 * The sole shared contract between the sandboxed renderer and Electron's main
 * process. Channel names and callable methods live together so a new feature
 * cannot silently update preload, renderer types, and main handlers out of
 * sync.
 */
export const IPC_CHANNELS = {
  source: {
    preview: "source:preview",
    confirm: "source:confirm",
    importOpml: "source:import-opml",
    list: "source:list",
    remove: "source:delete",
    refresh: "source:refresh",
    updateSettings: "source:update-settings",
    collectionSettings: "source:collection-settings",
    updateCollectionScope: "source:update-collection-scope",
    inspectCollectionFacets: "source:inspect-collection-facets",
    updateRule: "source:update-rule",
    calibration: "source:calibration",
    loadIcon: "source:load-icon"
  },
  entry: {
    listPage: "entry:list-page",
    counts: "entry:counts",
    readContent: "entry:read-content",
    readLanguageVariant: "entry:read-language-variant",
    openEmbedded: "entry:open-embedded",
    loadImage: "entry:load-image",
    markRead: "entry:read",
    markFavorite: "entry:favorite",
    dismiss: "entry:dismiss"
  },
  ai: {
    listProviders: "ai:list-providers",
    configure: "ai:configure",
    clearProvider: "ai:clear-provider",
    askStream: "ai:ask-stream",
    cancelStream: "ai:cancel-stream",
    streamEvent: "ai:stream"
  },
  window: {
    isFullscreen: "window:is-fullscreen",
    fullscreenChanged: "window:fullscreen-changed"
  },
  app: { openExternal: "app:open-external" },
  zhihu: { connect: "zhihu:connect", followLogin: "zhihu:follow-login" },
  x: { connect: "x:connect" },
  xiaohongshu: { subscribeProfile: "xiaohongshu:subscribe-profile" },
  academic: { search: "academic:search", subscribe: "academic:subscribe" }
} as const;

export type SourceSyncResult = { inserted: number; source: Source };

/** Renderer-safe surface exposed by preload through `window.reader`. */
export interface ReaderApi {
  previewSource(url: string): Promise<{ token: string; probe: ProbeResult }>;
  confirmSource(token: string): Promise<Source>;
  importOpml(): Promise<OpmlImportResult>;
  listSources(): Promise<Source[]>;
  deleteSource(id: string): Promise<void>;
  refreshSource(id: string): Promise<SourceSyncResult>;
  updateSourceSettings(id: string, settings: SourceSettings): Promise<Source>;
  getSourceCollectionSettings(id: string): Promise<SourceCollectionSettings>;
  updateSourceCollectionScope(id: string, scope: SubscriptionScope): Promise<SourceCollectionSettings>;
  inspectSourceCollectionFacets(id: string): Promise<SourceFacet[]>;
  updateRule(id: string, rule: Source["extractionRule"]): Promise<void>;
  calibrateSource(id: string): Promise<CalibrationResult>;
  subscribeXiaohongshuProfile(input: ProfileSubscriptionInput): Promise<Source>;
  listEntryPage(query?: EntryPageQuery): Promise<EntryPage>;
  getLibraryCounts(): Promise<LibraryCounts>;
  readEntry(id: string): Promise<ArticleReadResult>;
  /** Opens only a language URL declared by the currently loaded article. */
  readEntryLanguageVariant(id: string, url: string): Promise<ReaderArticle>;
  openEmbeddedEntry(id: string): Promise<void>;
  loadArticleImage(id: string, imageUrl: string): Promise<string>;
  loadSourceIcon(id: string): Promise<string | undefined>;
  markRead(id: string, read: boolean): Promise<void>;
  markFavorite(id: string, favorite: boolean): Promise<void>;
  dismissEntry(id: string): Promise<void>;
  listAiProviders(): Promise<AiProviderSettings[]>;
  configureAiProvider(configuration: AiProviderConfiguration): Promise<AiProviderSettings>;
  clearAiProvider(provider: AiProviderId): Promise<void>;
  startAiStream(request: AiStreamRequest): Promise<{ requestId: string }>;
  /** Best-effort cancellation for an in-flight request owned by this renderer. */
  cancelAiStream(requestId: string): Promise<void>;
  onAiStream(listener: (event: AiStreamEvent) => void): () => void;
  isWindowFullscreen(): Promise<boolean>;
  onWindowFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
  openExternal(url: string): Promise<void>;
  connectZhihu(accessSecret: string): Promise<SourceSyncResult>;
  connectZhihuFollow(): Promise<void>;
  connectX(clientId: string): Promise<SourceSyncResult>;
  searchAcademicAuthors(query: string): Promise<SubscriptionDraft[]>;
  subscribeAcademicAuthor(draft: SubscriptionDraft): Promise<SourceSyncResult>;
}
