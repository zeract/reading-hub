import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../shared/ipc";
import { awaitWithAbort, combineAbortSignals, throwIfAborted } from "./cancellation";
import { readOpmlFile } from "./opml-file";
import { WindowRequestScope } from "./window-request-scope";
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

type LibraryObserver = { id: number; sender: Electron.WebContents; onDestroyed(): void };

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
  const foregroundRequests = new WindowRequestScope();
  const observers = new Map<number, LibraryObserver>();
  function releaseObserver(observer: LibraryObserver): void {
    if (observers.get(observer.id) !== observer) return;
    observers.delete(observer.id);
    observer.sender.removeListener("destroyed", observer.onDestroyed);
  }
  function observeLibrary(sender: Electron.WebContents): void {
    const previous = observers.get(sender.id);
    if (sender.isDestroyed()) { if (previous?.sender === sender) releaseObserver(previous); return; }
    if (previous?.sender === sender) return;
    if (previous) releaseObserver(previous);
    const observer: LibraryObserver = { id: sender.id, sender, onDestroyed: () => releaseObserver(observer) };
    observers.set(sender.id, observer);
    sender.once("destroyed", observer.onDestroyed);
    if (sender.isDestroyed()) releaseObserver(observer);
  }
  const unsubscribeChanges = database?.onLibraryChanged?.((revision) => {
    for (const observer of observers.values()) {
      const { sender } = observer;
      try {
        if (sender.isDestroyed()) releaseObserver(observer);
        else sender.send(IPC_CHANNELS.entry.changed, revision);
      } catch {
        // One unavailable window must not prevent delivery to the others.
        // Keep its subscription so a transient failure can recover next time.
      }
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

  handle(IPC_CHANNELS.source.preview, (event, rawUrl: unknown) => {
    const url = requireText(rawUrl, "来源地址无效，请重新填写。", 2_000);
    return foregroundRequests.run(event.sender, (signal) => sources.preview(url, signal));
  });
  handle(IPC_CHANNELS.source.confirm, (_event, token: unknown) =>
    sources.confirm(requireEntityId(token, "预览已过期，请重新添加来源。")));
  handle(IPC_CHANNELS.source.importOpml, (event) => foregroundRequests.run(event.sender, async (signal): Promise<OpmlImportResult> => {
    const selection = await chooseOpmlFile(event.sender, signal);
    if (!selection) return { cancelled: true, imported: 0, existing: 0, skipped: 0 };
    const text = await readOpmlFile(selection, signal);
    throwIfAborted(signal);
    return { cancelled: false, ...sources.importOpml(text) };
  }));
  handle(IPC_CHANNELS.source.list, (event) => {
    observeLibrary(event.sender);
    return database.listSources();
  });
  handle(IPC_CHANNELS.source.subscribe, (_event, id: unknown, subscribed: unknown) => sources.setSubscribed(requireEntityId(id), requireBoolean(subscribed)));
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
  handle(IPC_CHANNELS.source.inspectCollectionFacets, (event, id: unknown) => {
    const sourceId = requireEntityId(id);
    return foregroundRequests.run(event.sender, (signal) => sources.inspectCollectionFacets(sourceId, signal));
  });
  handle(IPC_CHANNELS.source.updateRule, (_event, id: unknown, rule: unknown) =>
    sources.updateRule(requireEntityId(id), parseExtractionRule(rule)));
  handle(IPC_CHANNELS.source.calibration, (event, id: unknown) => {
    const sourceId = requireEntityId(id);
    return foregroundRequests.run(event.sender, (signal) => sources.calibrate(sourceId, signal));
  });
  handle(IPC_CHANNELS.source.loadIcon, (event, sourceId: unknown) => {
    const id = requireEntityId(sourceId);
    return foregroundRequests.run(event.sender, async (signal) => {
      const source = database.getSource(id);
      if (!source) return undefined;
      const iconUrl = sourceFaviconCandidate(source);
      if (!iconUrl) return undefined;
      try {
        return await http.getImageDataUrl(iconUrl, source.url, { signal });
      } catch {
        throwIfAborted(signal);
        // Decorative metadata never changes a source's health state.
        return undefined;
      }
    });
  });

  handle(IPC_CHANNELS.entry.listPage, (_event, query: unknown) => database.listEntryPage(parseEntryPageQuery(query)));
  handle(IPC_CHANNELS.entry.counts, () => database.getLibraryCounts());
  handle(IPC_CHANNELS.entry.readContent, (event, entryId: unknown, rawRequestId: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    const requestId = requireText(rawRequestId, "正文请求标识无效。", 160);
    return foregroundRequests.run(event.sender, async (signal) => {
      try {
        return { kind: "article" as const, article: await articles.read(entry, database.getSource(entry.sourceId), { signal }) };
      } catch (error) {
        throwIfAborted(signal);
        if (!(error instanceof RobotsDisallowedError)) throw error;
        await inAppArticleViewer.open(entry.url, entry.title, signal);
        return { kind: "embedded" as const };
      }
    }, `read:${requestId}`);
  });
  handle(IPC_CHANNELS.entry.readLanguageVariant, (event, entryId: unknown, rawUrl: unknown, rawRequestId: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    const url = requireText(rawUrl, "语言版本地址无效，请重新打开文章后再试。", 2_000);
    const requestId = requireText(rawRequestId, "正文请求标识无效。", 160);
    return foregroundRequests.run(event.sender, (signal) => articles.readLanguageVariant(
      entry, database.getSource(entry.sourceId), url, { signal }
    ), `read:${requestId}`);
  });
  handle(IPC_CHANNELS.entry.cancelRead, (event, rawRequestId: unknown) => {
    const requestId = requireText(rawRequestId, "正文请求标识无效。", 160);
    foregroundRequests.cancel(event.sender, `read:${requestId}`);
  });
  handle(IPC_CHANNELS.entry.openEmbedded, (event, entryId: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    return foregroundRequests.run(event.sender, (signal) => inAppArticleViewer.open(entry.url, entry.title, signal));
  });
  handle(IPC_CHANNELS.entry.loadImage, (event, entryId: unknown, imageUrl: unknown, rawRequestId: unknown) => {
    const entry = findEntry(database, requireEntityId(entryId));
    const url = requireText(imageUrl, "图片地址无效。", 4_000);
    const requestId = requireText(rawRequestId, "图片请求标识无效。", 160);
    return foregroundRequests.run(event.sender, (signal) => http.getImageDataUrl(url, entry.url, { signal }), `image:${requestId}`);
  });
  handle(IPC_CHANNELS.entry.cancelImage, (event, rawRequestId: unknown) => {
    const requestId = requireText(rawRequestId, "图片请求标识无效。", 160);
    foregroundRequests.cancel(event.sender, `image:${requestId}`);
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
    const stream = foregroundRequests.run(event.sender, async (signal) => {
      const combined = combineAbortSignals(signal, controller.signal);
      try {
        await startAiStream(event.sender, learningAssistant, request, combined.signal!);
      } finally {
        combined.dispose();
      }
    }).catch(() => {
      // Provider failures are delivered by startAiStream. Owner cancellation
      // or a destroyed IPC transport must not produce an unhandled rejection.
    }).finally(() => {
      const streams = aiStreamControllers.get(event.sender.id);
      if (streams?.get(request.requestId) === controller) streams.delete(request.requestId);
      if (!streams?.size) aiStreamControllers.delete(event.sender.id);
    });
    // The invoke acknowledges admission immediately; its background task still
    // belongs to the shutdown drain until provider cleanup has actually ended.
    pending.add(stream);
    void stream.then(() => { pending.delete(stream); });
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
  handle(IPC_CHANNELS.zhihu.followLogin, (event) =>
    foregroundRequests.run(event.sender, (signal) => sources.beginZhihuFollowLogin(signal)));
  handle(IPC_CHANNELS.x.connect, (event, rawClientId: unknown) => {
    const clientId = requireText(rawClientId, "X Client ID 无效。", 500);
    return foregroundRequests.run(event.sender, async (signal) => {
      const account = await x.authorizeWithClientId(clientId, signal);
      throwIfAborted(signal);
      return sync.syncSource(sources.ensureXSource(account).id);
    });
  });
  handle(IPC_CHANNELS.xiaohongshu.subscribeProfile, async (_event, input: unknown) => {
    const source = sources.createXiaohongshuProfileSource(parseProfileSubscriptionInput(input));
    return (await sync.syncSource(source.id)).source;
  });
  handle(IPC_CHANNELS.academic.search, (event, query: unknown) => {
    const text = requireText(query, "学术作者搜索词无效。", 500);
    return foregroundRequests.run(event.sender, (signal) => academic.discover(text, { signal }));
  });
  handle(IPC_CHANNELS.academic.subscribe, async (_event, draft: unknown) =>
    sync.syncSource(sources.createAcademicSource(parseAcademicDraft(draft)).id));

  return async () => {
    closing = true;
    unsubscribeChanges?.();
    for (const observer of observers.values()) releaseObserver(observer);
    for (const channel of channels) ipcMain.removeHandler(channel);
    foregroundRequests.close();
    await Promise.allSettled([...pending]);
  };
}

async function chooseOpmlFile(sender: Electron.WebContents, signal: AbortSignal): Promise<string | undefined> {
  const options = {
    title: "导入 OPML 订阅",
    properties: ["openFile"] as Array<"openFile">,
    filters: [{ name: "OPML 订阅", extensions: ["opml", "xml"] }]
  };
  const parent = BrowserWindow.fromWebContents(sender);
  const result = await awaitWithAbort(parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options), signal);
  return result.canceled ? undefined : result.filePaths[0];
}

function findEntry(database: ApplicationServices["database"], id: string) {
  const entry = database.getEntry(id);
  if (!entry) throw new Error("这篇内容已不存在。请刷新列表后重试。");
  return entry;
}

async function startAiStream(
  sender: Electron.WebContents,
  learningAssistant: ApplicationServices["learningAssistant"],
  payload: AiStreamRequest,
  signal: AbortSignal
): Promise<void> {
  const emit = (update: AiStreamEvent) => {
    if (!signal.aborted && !sender.isDestroyed()) sender.send(IPC_CHANNELS.ai.streamEvent, update);
  };
  // Queue after invoke returns so the renderer has registered its request id.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  if (signal.aborted) return;
  try {
    const answer = await learningAssistant.askStream(payload.request, (text) => emit({ type: "delta", requestId: payload.requestId, text }), signal);
    emit({ type: "complete", requestId: payload.requestId, answer });
  } catch (error: unknown) {
    emit({
      type: "error",
      requestId: payload.requestId,
      message: error instanceof Error && error.message ? error.message : "AI 学习助手暂时无法完成回答，请稍后重试。"
    });
  }
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
  }
  // A duplicate id is invalid at the renderer level, but cancelling the older
  // one is safer than allowing two provider requests to share an event key.
  controllers.get(requestId)?.abort(new Error("AI 请求已被新的请求替代。"));
  const controller = new AbortController();
  controllers.set(requestId, controller);
  return controller;
}
