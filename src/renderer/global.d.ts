import type { AiAnswer, AiProviderConfiguration, AiProviderId, AiProviderSettings, AiQuestionRequest, ArticleReadResult, CalibrationResult, Entry, ExtractionRule, Followee, ProbeResult, Source, SourceSettings, SubscriptionDraft } from "../shared/types";

declare global {
  interface Window {
    reader: {
      previewSource(url: string): Promise<{ token: string; probe: ProbeResult }>;
      confirmSource(token: string): Promise<Source>;
      listSources(): Promise<Source[]>;
      deleteSource(id: string): Promise<void>;
      refreshSource(id: string): Promise<unknown>;
      updateSourceSettings(id: string, settings: SourceSettings): Promise<Source>;
      updateRule(id: string, rule: ExtractionRule): Promise<void>;
      calibrateSource(id: string): Promise<CalibrationResult>;
      listEntries(sourceId?: string): Promise<Entry[]>;
      readEntry(id: string): Promise<ArticleReadResult>;
      openEmbeddedEntry(id: string): Promise<void>;
      loadArticleImage(id: string, imageUrl: string): Promise<string>;
      listFollowees(): Promise<Followee[]>;
      markRead(id: string, read: boolean): Promise<void>;
      markFavorite(id: string, favorite: boolean): Promise<void>;
      dismissEntry(id: string): Promise<void>;
      listAiProviders(): Promise<AiProviderSettings[]>;
      configureAiProvider(configuration: AiProviderConfiguration): Promise<AiProviderSettings>;
      clearAiProvider(provider: AiProviderId): Promise<void>;
      askAi(request: AiQuestionRequest): Promise<AiAnswer>;
      openExternal(url: string): Promise<void>;
      connectZhihu(accessSecret: string): Promise<unknown>;
      connectZhihuFollow(): Promise<void>;
      connectX(clientId: string): Promise<unknown>;
      searchAcademicAuthors(query: string): Promise<SubscriptionDraft[]>;
      subscribeAcademicAuthor(draft: SubscriptionDraft): Promise<unknown>;
    };
  }
}

export {};
