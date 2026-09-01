import { contextBridge, ipcRenderer } from "electron";
import type { IPC_CHANNELS as SharedIpcChannels, ReaderApi } from "../shared/ipc";
import type { AiStreamEvent } from "../shared/types";

// Sandboxed Electron preloads may only require Electron's approved built-ins.
// In particular, a compiled `require("../shared/ipc")` aborts before this
// bridge is exposed and leaves the renderer with a blank window. Keep the
// channel values in this self-contained preload bundle, while `satisfies`
// makes TypeScript reject any divergence from the shared main/renderer
// contract at build time. Both imports above are type-only and are erased.
const IPC_CHANNELS = {
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
} as const satisfies typeof SharedIpcChannels;

const readerApi: ReaderApi = {
  previewSource: (url) => ipcRenderer.invoke(IPC_CHANNELS.source.preview, url),
  confirmSource: (token) => ipcRenderer.invoke(IPC_CHANNELS.source.confirm, token),
  importOpml: () => ipcRenderer.invoke(IPC_CHANNELS.source.importOpml),
  listSources: () => ipcRenderer.invoke(IPC_CHANNELS.source.list),
  deleteSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.remove, id),
  refreshSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.refresh, id),
  updateSourceSettings: (id, settings) => ipcRenderer.invoke(IPC_CHANNELS.source.updateSettings, id, settings),
  getSourceCollectionSettings: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.collectionSettings, id),
  updateSourceCollectionScope: (id, scope) => ipcRenderer.invoke(IPC_CHANNELS.source.updateCollectionScope, id, scope),
  inspectSourceCollectionFacets: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.inspectCollectionFacets, id),
  updateRule: (id, rule) => ipcRenderer.invoke(IPC_CHANNELS.source.updateRule, id, rule),
  calibrateSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.calibration, id),
  subscribeXiaohongshuProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.xiaohongshu.subscribeProfile, input),
  listEntryPage: (query) => ipcRenderer.invoke(IPC_CHANNELS.entry.listPage, query),
  getLibraryCounts: () => ipcRenderer.invoke(IPC_CHANNELS.entry.counts),
  readEntry: (id) => ipcRenderer.invoke(IPC_CHANNELS.entry.readContent, id),
  readEntryLanguageVariant: (id, url) => ipcRenderer.invoke(IPC_CHANNELS.entry.readLanguageVariant, id, url),
  openEmbeddedEntry: (id) => ipcRenderer.invoke(IPC_CHANNELS.entry.openEmbedded, id),
  loadArticleImage: (id, imageUrl) => ipcRenderer.invoke(IPC_CHANNELS.entry.loadImage, id, imageUrl),
  loadSourceIcon: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.loadIcon, id),
  markRead: (id, read) => ipcRenderer.invoke(IPC_CHANNELS.entry.markRead, id, read),
  markFavorite: (id, favorite) => ipcRenderer.invoke(IPC_CHANNELS.entry.markFavorite, id, favorite),
  dismissEntry: (id) => ipcRenderer.invoke(IPC_CHANNELS.entry.dismiss, id),
  listAiProviders: () => ipcRenderer.invoke(IPC_CHANNELS.ai.listProviders),
  configureAiProvider: (configuration) => ipcRenderer.invoke(IPC_CHANNELS.ai.configure, configuration),
  clearAiProvider: (provider) => ipcRenderer.invoke(IPC_CHANNELS.ai.clearProvider, provider),
  startAiStream: (request) => ipcRenderer.invoke(IPC_CHANNELS.ai.askStream, request),
  onAiStream: (listener: (event: AiStreamEvent) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isAiStreamEvent(value)) listener(value);
    };
    ipcRenderer.on(IPC_CHANNELS.ai.streamEvent, receive);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ai.streamEvent, receive);
  },
  isWindowFullscreen: () => ipcRenderer.invoke(IPC_CHANNELS.window.isFullscreen),
  onWindowFullscreenChange: (listener: (fullscreen: boolean) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => listener(Boolean(fullscreen));
    ipcRenderer.on(IPC_CHANNELS.window.fullscreenChanged, receive);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.window.fullscreenChanged, receive);
  },
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.app.openExternal, url),
  connectZhihu: (accessSecret) => ipcRenderer.invoke(IPC_CHANNELS.zhihu.connect, accessSecret),
  connectZhihuFollow: () => ipcRenderer.invoke(IPC_CHANNELS.zhihu.followLogin),
  connectX: (clientId) => ipcRenderer.invoke(IPC_CHANNELS.x.connect, clientId),
  searchAcademicAuthors: (query) => ipcRenderer.invoke(IPC_CHANNELS.academic.search, query),
  subscribeAcademicAuthor: (draft) => ipcRenderer.invoke(IPC_CHANNELS.academic.subscribe, draft)
};

contextBridge.exposeInMainWorld("reader", readerApi);

function isAiStreamEvent(value: unknown): value is AiStreamEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AiStreamEvent>;
  if (typeof event.requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(event.requestId)) return false;
  if (event.type === "delta") return typeof event.text === "string";
  if (event.type === "complete") return Boolean(event.answer && typeof event.answer.text === "string");
  return event.type === "error" && typeof event.message === "string";
}
