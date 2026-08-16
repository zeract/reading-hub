import { contextBridge, ipcRenderer } from "electron";
import type { AiProviderConfiguration, AiProviderId, AiStreamEvent, AiStreamRequest, EntryListQuery, ExtractionRule, SourceSettings, SubscriptionDraft } from "../shared/types";

contextBridge.exposeInMainWorld("reader", {
  previewSource: (url: string) => ipcRenderer.invoke("source:preview", url),
  confirmSource: (token: string) => ipcRenderer.invoke("source:confirm", token),
  listSources: () => ipcRenderer.invoke("source:list"),
  deleteSource: (id: string) => ipcRenderer.invoke("source:delete", id),
  refreshSource: (id: string) => ipcRenderer.invoke("source:refresh", id),
  updateSourceSettings: (id: string, settings: SourceSettings) => ipcRenderer.invoke("source:update-settings", id, settings),
  updateRule: (id: string, rule: ExtractionRule) => ipcRenderer.invoke("source:update-rule", id, rule),
  calibrateSource: (id: string) => ipcRenderer.invoke("source:calibration", id),
  listEntries: (query?: EntryListQuery) => ipcRenderer.invoke("entry:list", query),
  readEntry: (id: string) => ipcRenderer.invoke("entry:read-content", id),
  openEmbeddedEntry: (id: string) => ipcRenderer.invoke("entry:open-embedded", id),
  loadArticleImage: (id: string, imageUrl: string) => ipcRenderer.invoke("entry:load-image", id, imageUrl),
  listFollowees: () => ipcRenderer.invoke("zhihu:followees"),
  markRead: (id: string, read: boolean) => ipcRenderer.invoke("entry:read", id, read),
  markFavorite: (id: string, favorite: boolean) => ipcRenderer.invoke("entry:favorite", id, favorite),
  dismissEntry: (id: string) => ipcRenderer.invoke("entry:dismiss", id),
  listAiProviders: () => ipcRenderer.invoke("ai:list-providers"),
  configureAiProvider: (configuration: AiProviderConfiguration) => ipcRenderer.invoke("ai:configure", configuration),
  clearAiProvider: (provider: AiProviderId) => ipcRenderer.invoke("ai:clear-provider", provider),
  startAiStream: (request: AiStreamRequest) => ipcRenderer.invoke("ai:ask-stream", request),
  onAiStream: (listener: (event: AiStreamEvent) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isAiStreamEvent(value)) listener(value);
    };
    ipcRenderer.on("ai:stream", receive);
    return () => ipcRenderer.removeListener("ai:stream", receive);
  },
  isWindowFullscreen: () => ipcRenderer.invoke("window:is-fullscreen"),
  onWindowFullscreenChange: (listener: (fullscreen: boolean) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => listener(Boolean(fullscreen));
    ipcRenderer.on("window:fullscreen-changed", receive);
    return () => ipcRenderer.removeListener("window:fullscreen-changed", receive);
  },
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  connectZhihu: (accessSecret: string) => ipcRenderer.invoke("zhihu:connect", accessSecret),
  connectZhihuFollow: () => ipcRenderer.invoke("zhihu:follow-login"),
  connectX: (clientId: string) => ipcRenderer.invoke("x:connect", clientId),
  searchAcademicAuthors: (query: string) => ipcRenderer.invoke("academic:search", query),
  subscribeAcademicAuthor: (draft: SubscriptionDraft) => ipcRenderer.invoke("academic:subscribe", draft)
});

function isAiStreamEvent(value: unknown): value is AiStreamEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AiStreamEvent>;
  if (typeof event.requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(event.requestId)) return false;
  if (event.type === "delta") return typeof event.text === "string";
  if (event.type === "complete") return Boolean(event.answer && typeof event.answer.text === "string");
  return event.type === "error" && typeof event.message === "string";
}
