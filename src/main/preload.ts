import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type ReaderApi } from "../shared/ipc";
import type { AiStreamEvent } from "../shared/types";

const readerApi: ReaderApi = {
  previewSource: (url) => ipcRenderer.invoke(IPC_CHANNELS.source.preview, url),
  confirmSource: (token) => ipcRenderer.invoke(IPC_CHANNELS.source.confirm, token),
  importOpml: () => ipcRenderer.invoke(IPC_CHANNELS.source.importOpml),
  listSources: () => ipcRenderer.invoke(IPC_CHANNELS.source.list),
  deleteSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.remove, id),
  refreshSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.refresh, id),
  updateSourceSettings: (id, settings) => ipcRenderer.invoke(IPC_CHANNELS.source.updateSettings, id, settings),
  updateRule: (id, rule) => ipcRenderer.invoke(IPC_CHANNELS.source.updateRule, id, rule),
  calibrateSource: (id) => ipcRenderer.invoke(IPC_CHANNELS.source.calibration, id),
  subscribeXiaohongshuProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.xiaohongshu.subscribeProfile, input),
  listEntries: (query) => ipcRenderer.invoke(IPC_CHANNELS.entry.list, query),
  getLibraryCounts: () => ipcRenderer.invoke(IPC_CHANNELS.entry.counts),
  readEntry: (id) => ipcRenderer.invoke(IPC_CHANNELS.entry.readContent, id),
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
