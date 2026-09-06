import { lstat, readFile } from "node:fs/promises";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../shared/ipc";
import { throwIfAborted } from "./cancellation";
import { assertPublicUrl } from "../shared/url";
import type { AiStreamEvent, AiStreamRequest, OpmlImportResult } from "../shared/types";
import { sourceFaviconCandidate } from "../shared/source-icon";
import type { ApplicationServices } from "./app-services";
import {
  parseAiStreamRequest,
  parseAiStreamRequestId,
  parseAcademicDraft,
  parseAiProviderConfiguration,
  parseAiProviderId,
  parseEntryPageQuery,
  parseExtractionRule,
  parseProfileSubscriptionInput,
  parseSubscriptionScope,
  parseSourceSettings,
  requireBoolean,
  requireEntityId,
  requireText
} from "./ipc-validation";
import { RobotsDisallowedError } from "./robots";

const MAX_OPML_BYTES = 2_000_000;

/**
 * The renderer receives only this small, validated IPC surface. Services stay
 * unaware of Electron events, windows, dialogs, and untrusted IPC payloads.
 */
export function registerIpcHandlers(services: ApplicationServices): () => Promise<void> {
  const {
    database,
    http,
    secrets,
    sources,
    sync,
    x,
    academic,
    learningAssistant,
    articles,
    inAppArticleViewer
  } = services;
  // Renderer requests are scoped to their owning WebContents. A malicious or
  // stale renderer cannot cancel another window's AI turn by guessing an id.
  const aiStreamControllers = new Map<number, Map<string, AbortController>>();
  const xAuthorizationControllers = new Set<AbortController>();
  const observers = new Map<number, Electron.WebContents>();
  const unsubscribeChanges = database?.onLibraryChanged?.((revision) => {
    for (const [id, sender] of observers) {
      if (sender.isDestroyed()) observers.delete(id);
      else sender.send(IPC_CHANNELS.entry.changed, revision);
    }
  });
  const pending = new Set<Promise<unknown>>();
  const channels: string[] = [];
  let closing = false;

  function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
    channels.push(channel);
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (closing) throw new Error("应用正在退出，请稍后重新打开。");
      const request = Promise.resolve(listener(event, ...args));
      pending.add(request);
      return request.finally(() => { pending.delete(request); database?.publishChanges?.(); });
    });
  }

  handle(IPC_CHANNELS.source.preview, (_event, rawUrl: unknown) =>
    sources.preview(requireText(rawUrl, "来源地址无效，请重新填写。", 2_000)));
  handle(IPC_CHANNELS.source.confirm, (_event, token: unknown) =>
    sources.confirm(requireEntityId(token, "预览已过期，请重新添加来源。")));
  handle(IPC_CHANNELS.source.importOpml, async (event): Promise<OpmlImportResult> => {
    const selection = await chooseOpmlFile(event.sender);
    if (!selection) return { cancelled: true, imported: 0, existing: 0, skipped: 0 };
    const file = await lstat(selection);
    if (!file.isFile() || file.size > MAX_OPML_BYTES) throw new Error("OPML 文件必须是小于 2 MB 的普通文件。");
    const text = await readFile(selection, "utf8");
    return { cancelled: false, ...sources.importOpml(text) };
  });
  handle(IPC_CHANNELS.source.list, (event) => {
    observers.set(event.sender.id, event.sender);
    return database.listSources();
  });
  handle(IPC_CHANNELS.source.subscribe, (_event, id: unknown, subscribed: unknown) => sources.setSubscribed(requireEntityId(id), requireBoolean(subscribed)));
  handle(IPC_CHANNELS.source.clearContent, (_event, id: unknown) => database.clearSourceContent(requireEntityId(id)));
  handle(IPC_CHANNELS.entry.restore, (_event, id: unknown) => database.restoreEntry(requireEntityId(id)));
  handle(IPC_CHANNELS.entry.revision, () => database.getLibraryRevision());
  handle(IPC_CHANNELS.source.remove, (_event, id: unknown) => sources.delete(requireEntityId(id)));
  handle(IPC_CHANNELS.source.refresh, (_event, id: unknown) => sync.syncSource(requireEntityId(id)));
  handle(IPC_CHANNELS.source.updateSettings, (_event, id: unknown, settings: unknown) =>
    sources.updateSettings(requireEntityId(id), parseSourceSettings(settings)));
  handle(IPC_CHANNELS.source.collectionSettings, (_event, id: unknown) =>
    sources.getCollectionSettings(requireEntityId(id)));
  handle(IPC_CHANNELS.source.updateCollectionScope, (_event, id: unknown, scope: unknown) =>
    sources.updateCollectionScope(requireEntityId(id), parseSubscriptionScope(scope)));
  handle(IPC_CHANNELS.source.inspectCollectionFacets, (_event, id: unknown) =>
    sources.inspectCollectionFacets(requireEntityId(id)));
  handle(IPC_CHANNELS.source.updateRule, (_event, id: unknown, rule: unknown) =>
    database.updateRule(requireEntityId(id), parseExtractionRule(rule)));
  handle(IPC_CHANNELS.source.calibration, (_event, id: unknown) => sources.calibrate(requireEntityId(id)));
  handle(IPC_CHANNELS.source.loadIcon, async (_event, sourceId: unknown) => {
    const source = database.getSource(requireEntityId(sourceId));
    if (!source) return undefined;
    const iconUrl = sourceFaviconCandidate(source);
    if (!iconUrl) return undefined;
    try {
      return await http.getImageDataUrl(iconUrl, source.url);
    } catch {
      // Decorative metadata never changes a source's health state.
      return undefined;
    }
  });

  handle(IPC_CHANNELS.entry.listPage, (_event, query: unknown) => database.listEntryPage(parseEntryPageQuery(query)));
  handle(IPC_CHANNELS.entry.counts, () => database.getLibraryCounts());
  handle(IPC_CHANNELS.entry.readContent, async (_event, entryId: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    try {
      return { kind: "article" as const, article: await articles.read(entry, database.getSource(entry.sourceId)) };
    } catch (error) {
      if (!(error instanceof RobotsDisallowedError)) throw error;
      await inAppArticleViewer.open(entry.url, entry.title);
      return { kind: "embedded" as const };
    }
  });
  handle(IPC_CHANNELS.entry.readLanguageVariant, async (_event, entryId: unknown, rawUrl: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    return articles.readLanguageVariant(
      entry,
      database.getSource(entry.sourceId),
      requireText(rawUrl, "语言版本地址无效，请重新打开文章后再试。", 2_000)
    );
  });
  handle(IPC_CHANNELS.entry.openEmbedded, async (_event, entryId: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    await inAppArticleViewer.open(entry.url, entry.title);
  });
  handle(IPC_CHANNELS.entry.loadImage, async (_event, entryId: unknown, imageUrl: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    return http.getImageDataUrl(requireText(imageUrl, "图片地址无效。", 4_000), entry.url);
  });
  handle(IPC_CHANNELS.entry.markRead, (_event, id: unknown, read: unknown) =>
    database.markRead(requireEntityId(id), requireBoolean(read)));
  handle(IPC_CHANNELS.entry.markFavorite, (_event, id: unknown, favorite: unknown) =>
    database.markFavorite(requireEntityId(id), requireBoolean(favorite)));
  handle(IPC_CHANNELS.entry.dismiss, (_event, id: unknown) => database.dismissEntry(requireEntityId(id)));

  handle(IPC_CHANNELS.ai.listProviders, () => learningAssistant.listProviders());
  handle(IPC_CHANNELS.ai.configure, (_event, configuration: unknown) =>
    learningAssistant.configure(parseAiProviderConfiguration(configuration)));
  handle(IPC_CHANNELS.ai.clearProvider, (_event, provider: unknown) =>
    learningAssistant.clear(parseAiProviderId(provider)));
  handle(IPC_CHANNELS.ai.askStream, (event, payload: unknown) => {
    const request = parseAiStreamRequest(payload);
    const controller = registerAiStreamController(aiStreamControllers, event.sender, request.requestId);
    startAiStream(event.sender, learningAssistant, request, controller.signal, () => {
      const streams = aiStreamControllers.get(event.sender.id);
      if (streams?.get(request.requestId) === controller) streams.delete(request.requestId);
    });
    return { requestId: request.requestId };
  });
  handle(IPC_CHANNELS.ai.cancelStream, (event, rawRequestId: unknown) => {
    const requestId = parseAiStreamRequestId(rawRequestId);
    aiStreamControllers.get(event.sender.id)?.get(requestId)?.abort(new Error("AI 请求已取消。"));
  });

  handle(IPC_CHANNELS.window.isFullscreen, (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  handle(IPC_CHANNELS.app.openExternal, (_event, rawUrl: unknown) =>
    shell.openExternal(assertPublicUrl(requireText(rawUrl, "外部链接无效。", 2_000)).toString()));
  handle(IPC_CHANNELS.zhihu.connect, async (_event, rawSecret: unknown) => {
    await secrets.setZhihuAccessSecret(requireText(rawSecret, "知乎 Access Secret 无效。", 2_000));
    return sync.syncSource(sources.connectZhihu().id);
  });
  handle(IPC_CHANNELS.zhihu.followLogin, () => sources.beginZhihuFollowLogin());
  handle(IPC_CHANNELS.x.connect, async (event, rawClientId: unknown) => {
    const clientId = requireText(rawClientId, "X Client ID 无效。", 500);
    const controller = new AbortController();
    const onDestroyed = () => controller.abort(new Error("授权窗口已关闭，已取消 X 授权。"));
    xAuthorizationControllers.add(controller);
    event.sender.once("destroyed", onDestroyed);
    try {
      if (event.sender.isDestroyed()) onDestroyed();
      throwIfAborted(controller.signal);
      const account = await x.authorizeWithClientId(clientId, controller.signal);
      throwIfAborted(controller.signal);
      return await sync.syncSource(sources.ensureXSource(account).id);
    } finally {
      event.sender.removeListener("destroyed", onDestroyed);
      xAuthorizationControllers.delete(controller);
    }
  });
  handle(IPC_CHANNELS.xiaohongshu.subscribeProfile, async (_event, input: unknown) => {
    const source = sources.createXiaohongshuProfileSource(parseProfileSubscriptionInput(input));
    return (await sync.syncSource(source.id)).source;
  });
  handle(IPC_CHANNELS.academic.search, (_event, query: unknown) =>
    academic.discover(requireText(query, "学术作者搜索词无效。", 500)));
  handle(IPC_CHANNELS.academic.subscribe, async (_event, draft: unknown) =>
    sync.syncSource(sources.createAcademicSource(parseAcademicDraft(draft)).id));

  return async () => {
    closing = true;
    unsubscribeChanges?.();
    observers.clear();
    for (const channel of channels) ipcMain.removeHandler(channel);
    for (const controller of xAuthorizationControllers) controller.abort(new Error("应用正在退出，已取消 X 授权。"));
    for (const streams of aiStreamControllers.values()) {
      for (const controller of streams.values()) controller.abort(new Error("应用正在退出。"));
    }
    await Promise.allSettled([...pending]);
  };
}

async function chooseOpmlFile(sender: Electron.WebContents): Promise<string | undefined> {
  const options = {
    title: "导入 OPML 订阅",
    properties: ["openFile"] as Array<"openFile">,
    filters: [{ name: "OPML 订阅", extensions: ["opml", "xml"] }]
  };
  const parent = BrowserWindow.fromWebContents(sender);
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

function findEntry(database: ApplicationServices["database"], id: string) {
  const entry = database.getEntry(id);
  if (!entry) throw new Error("这篇内容已不存在。请刷新列表后重试。");
  return entry;
}

function startAiStream(
  sender: Electron.WebContents,
  learningAssistant: ApplicationServices["learningAssistant"],
  payload: AiStreamRequest,
  signal: AbortSignal,
  onSettled: () => void
): void {
  const emit = (update: AiStreamEvent) => {
    if (!signal.aborted && !sender.isDestroyed()) sender.send(IPC_CHANNELS.ai.streamEvent, update);
  };
  // Queue after invoke returns so the renderer has registered its request id.
  queueMicrotask(() => {
    if (signal.aborted) { onSettled(); return; }
    void learningAssistant.askStream(payload.request, (text) => emit({ type: "delta", requestId: payload.requestId, text }), signal)
      .then((answer) => emit({ type: "complete", requestId: payload.requestId, answer }))
      .catch((error: unknown) => emit({
        type: "error",
        requestId: payload.requestId,
        message: error instanceof Error && error.message ? error.message : "AI 学习助手暂时无法完成回答，请稍后重试。"
      }))
      .finally(onSettled);
  });
}

function registerAiStreamController(
  controllersByWebContents: Map<number, Map<string, AbortController>>,
  sender: Electron.WebContents,
  requestId: string
): AbortController {
  let controllers = controllersByWebContents.get(sender.id);
  if (!controllers) {
    controllers = new Map();
    controllersByWebContents.set(sender.id, controllers);
    sender.once("destroyed", () => {
      for (const controller of controllers!.values()) controller.abort(new Error("阅读窗口已关闭。"));
      controllersByWebContents.delete(sender.id);
    });
  }
  // A duplicate id is invalid at the renderer level, but cancelling the older
  // one is safer than allowing two provider requests to share an event key.
  controllers.get(requestId)?.abort(new Error("AI 请求已被新的请求替代。"));
  const controller = new AbortController();
  controllers.set(requestId, controller);
  return controller;
}
