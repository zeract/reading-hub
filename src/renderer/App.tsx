import { sourceCapabilities } from "../shared/source-capabilities";
import { useCallback, useEffect, useState } from "react";
import type { Entry, OpmlImportResult, Source } from "../shared/types";
import type { PendingPreview } from "../shared/ipc";
import { errorMessage } from "./errors";
import { Timeline, SourceSidebar } from "./library-pane";
import type { LibraryView } from "./library-view";
import { ReaderPlaceholder, ReaderView } from "./reader-view";
import { SettingsView } from "./settings-view";
import { AddSourceDialog, CalibrationDialog, isRetiredXPublicProfile, PreviewDialog, SourceSettingsDialog } from "./source-dialogs";
import { AppIcon } from "./ui-icons";
import { useLibraryData } from "./use-library-data";
import { useAsyncActivity } from "./use-async-activity";
import { useLibraryNotice } from "./use-library-notice";
import { useEntryMutations, type EntryMutationField } from "./use-entry-mutations";
import { useWindowFullscreen } from "./use-window-fullscreen";
import { ReaderPreferencesProvider } from "./reader-preferences-context";

type AppView = "library" | "settings";
type SourceDialogSession = { token: string; mode: "settings" | "calibration"; source: Source };

/**
 * The application shell owns cross-feature state and coordinates safe IPC
 * calls. Feature views remain independently testable and never reach across
 * one another for state.
 */
export function App() {
  return <ReaderPreferencesProvider><AppShell /></ReaderPreferencesProvider>;
}

function AppShell() {
  const {
    sources,
    entries,
    hasMoreEntries,
    loadingMoreEntries,
    loadingEntries,
    entryLoadFailed,
    reloadError,
    paginationError,
    clearReloadError,
    libraryCounts,
    libraryCountsStale,
    activeSourceId,
    libraryView,
    entrySearch,
    sourceById,
    activeSource,
    sourceGroups,
    applyEntryState,
    reload,
    loadMoreEntries,
    selectSource: selectLibrarySource,
    selectLibrary: selectLibraryView,
    setEntrySearch,
    clearActiveSource
  } = useLibraryData();
  const [pending, setPending] = useState<PendingPreview>();
  const { notice, show: setNotice, updateIfCurrent: updateNotice, begin: beginNotice, capture: captureNotice } = useLibraryNotice();
  const undoEntry = notice?.undoEntry;
  const { busy, track } = useAsyncActivity();
  const [addSourceSession, setAddSourceSession] = useState<string>();
  const [sourceDialog, setSourceDialog] = useState<SourceDialogSession>();
  const [collapsedSourceGroups, setCollapsedSourceGroups] = useState<Record<string, boolean>>({});
  const [readingEntry, setReadingEntry] = useState<Entry>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [readerOnly, setReaderOnly] = useState(false);
  const [appView, setAppView] = useState<AppView>("library");
  const windowFullscreen = useWindowFullscreen();

  useEffect(() => {
    setSourceDialog((current) => {
      if (!current) return current;
      const source = sources.find((item) => item.id === current.source.id);
      return source ? { ...current, source } : undefined;
    });
  }, [sources]);

  useEffect(() => {
    // Follow refreshed metadata for the selected identity. Falling out of a
    // filter (for example after marking read) must not close the reader.
    setReadingEntry((current) => current ? entries.find((entry) => entry.id === current.id) ?? current : current);
  }, [entries]);

  const openSourceSettings = useCallback((source: Source) => {
    setSourceDialog({ token: crypto.randomUUID(), mode: "settings", source });
  }, []);
  const closeSourceDialog = useCallback((token: string) => {
    setSourceDialog((current) => current?.token === token ? undefined : current);
  }, []);
  const finishSourceManagement = useCallback(async (token: string) => {
    closeSourceDialog(token);
    await reload();
  }, [closeSourceDialog, reload]);

  useEffect(() => {
    if (!readingEntry) setReaderOnly(false);
  }, [readingEntry]);

  const acceptPreview = useCallback((result: PendingPreview) => {
    setPending(result);
    setAddSourceSession(undefined);
    setNotice(undefined);
  }, [setNotice]);

  const closeAddSource = useCallback((session: string) => {
    setAddSourceSession((current) => current === session ? undefined : current);
  }, []);

  const openAddSource = useCallback(() => setAddSourceSession(crypto.randomUUID()), []);

  const finishSourceAddition = useCallback(async (session: string, message: string) => {
    closeAddSource(session);
    setNotice(message);
    await reload();
  }, [closeAddSource, reload, setNotice]);

  const importOpml = useCallback((): Promise<OpmlImportResult> => track(async () => {
    setNotice(undefined);
    let result: OpmlImportResult;
    try {
      result = await window.reader.importOpml();
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      throw error;
    }
    if (!result.cancelled) {
      const details = [`导入 ${result.imported} 个 Feed`];
      if (result.existing) details.push(`${result.existing} 个已存在`);
      if (result.skipped) details.push(`${result.skipped} 个无效或不支持`);
      setNotice(`${details.join("；")}。正在按安全限流初始化同步。`);
      // The import result is already committed. List recovery owns its error
      // and retry; it cannot turn those counts into a failed import.
      await reload().catch(() => undefined);
    }
    return result;
  }), [reload, setNotice, track]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const source = await window.reader.confirmSource(pending.token);
    setPending((current) => current?.token === pending.token ? undefined : current);
    setNotice(source.status === "needs_review" ? "已保存，但需要校正提取规则后才会自动刷新。" : "来源已添加。");
    await reload();
  }, [pending, reload, setNotice]);

  const refresh = useCallback((source: Source) => track(async () => {
    const publish = beginNotice();
    try {
      await window.reader.refreshSource(source.id);
    } catch (error) {
      await reload().catch(() => undefined);
      publish(errorMessage(error));
      throw error;
    }
    // The source operation has completed. A failed list read keeps its own
    // retry UI; it must not trigger another read or reject a saved scope's refresh.
    await reload().catch(() => undefined);
    publish(`已检查「${source.title}」。`);
  }), [beginNotice, reload, track]);

  const commitEntryState = useCallback((entryId: string, field: EntryMutationField, value: boolean) => {
    applyEntryState(entryId, field, value);
    setReadingEntry((current) => current?.id === entryId ? { ...current, [field]: value } : current);
  }, [applyEntryState]);
  const { updateEntry, isEntryUpdating } = useEntryMutations({ onCommitted: commitEntryState, reload, createErrorReporter: captureNotice });

  const openReader = useCallback((entry: Entry) => {
    setReadingEntry(entry);
  }, []);

  const selectSource = useCallback((sourceId?: string) => {
    setReadingEntry(undefined);
    selectLibrarySource(sourceId);
  }, [selectLibrarySource]);

  const selectLibrary = useCallback((view: LibraryView) => {
    setReadingEntry(undefined);
    selectLibraryView(view);
  }, [selectLibraryView]);

  const toggleSourceSubscription = useCallback((source: Source): Promise<void> => track(async () => {
    try {
      await window.reader.setSourceSubscribed(source.id, source.subscribed === false);
    } catch (error) {
      setNotice(errorMessage(error));
      throw error;
    }
    clearActiveSource(source.id);
    setNotice(source.subscribed === false ? `已重新订阅「${source.title}」。` : `已取消订阅「${source.title}」，已有内容与收藏已保留。`);
    // Close the completed command's dialog even if its read model needs retry.
    await reload().catch(() => undefined);
  }), [clearActiveSource, reload, setNotice, track]);

  const dismissEntry = useCallback((entry: Entry) => track(async () => {
    try {
      await window.reader.dismissEntry(entry.id);
    } catch (error) {
      setNotice(errorMessage(error));
      return;
    }
    setReadingEntry((current) => current?.id === entry.id ? undefined : current);
    setNotice(`已删除「${entry.title}」。`, entry);
    // Preserve the committed deletion and its undo even if list recovery fails.
    // Reload errors belong to the read model, as they do for restoration.
    await reload().catch(() => undefined);
  }), [reload, setNotice, track]);

  const restoreEntry = useCallback((entry: Entry, noticeId?: string) => track(async () => {
    try {
      await window.reader.restoreEntry(entry.id);
    } catch (error) {
      const message = errorMessage(error);
      if (noticeId) updateNotice(noticeId, { message, undoEntry: entry });
      else setNotice(message);
      return;
    }
    if (noticeId) updateNotice(noticeId, { message: "内容已恢复。" });
    else setNotice("内容已恢复。");
    // The read model owns reload errors. A failed list read must not turn
    // an already successful restoration back into a pending undo.
    await reload().catch(() => undefined);
  }), [reload, setNotice, track, updateNotice]);

  const refreshCurrentView = useCallback(() => {
    if (activeSource) {
      if (isRetiredXPublicProfile(activeSource)) {
        setNotice("此旧 X 公开来源已停止刷新：X 没有提供可合规自动读取的公开订阅接口。可保留已有卡片，或删除来源后使用官方 API。");
        return;
      }
      // The toolbar owns its notice; dialog callers receive the rejection
      // so their local action cannot mistake a failed refresh for success.
      void refresh(activeSource).catch(() => undefined);
      return;
    }
    const publish = beginNotice();
    void reload().then(() => publish("已重新载入收件箱。")).catch((error) => publish(errorMessage(error)));
  }, [activeSource, beginNotice, refresh, reload, setNotice]);

  if (appView === "settings") {
    return <SettingsView onClose={() => setAppView("library")} windowFullscreen={windowFullscreen} />;
  }

  return (
    <main className={`shell${sidebarCollapsed ? " shell--sidebar-collapsed" : ""}${readerOnly ? " shell--reader-only" : ""}${windowFullscreen ? " shell--fullscreen" : ""}`}>
      <header className="app-titlebar">
        <div className="app-titlebar-actions">
          <button type="button" className="app-titlebar-button" onClick={() => readerOnly ? setReaderOnly(false) : setSidebarCollapsed((collapsed) => !collapsed)} aria-label={readerOnly ? "退出沉浸阅读" : sidebarCollapsed ? "显示来源边栏" : "隐藏来源边栏"} title={readerOnly ? "退出沉浸阅读" : sidebarCollapsed ? "显示来源边栏" : "隐藏来源边栏"}><AppIcon name={readerOnly ? "expand" : "sidebar"} /></button>
          {!readerOnly && <button type="button" className="app-titlebar-button" onClick={refreshCurrentView} disabled={busy || Boolean(activeSource && !sourceCapabilities(activeSource).canRefresh)} aria-label={activeSource ? `刷新 ${activeSource.title}` : "重新载入收件箱"} title={isRetiredXPublicProfile(activeSource) ? "此旧 X 公开来源已停止刷新" : activeSource ? "刷新当前来源" : "重新载入收件箱"}><AppIcon name="refresh" /></button>}
          {!readerOnly && <button type="button" className="app-titlebar-button app-titlebar-add" onClick={openAddSource} aria-label="添加来源" title="添加来源"><AppIcon name="add" /></button>}
        </div>
      </header>
      <SourceSidebar
        sources={sources}
        groups={sourceGroups}
        libraryView={libraryView}
        activeSourceId={activeSourceId}
        libraryCounts={libraryCounts}
        countsStale={libraryCountsStale}
        collapsedGroups={collapsedSourceGroups}
        onSelectLibrary={selectLibrary}
        onSelectSource={selectSource}
        onToggleGroup={(groupId) => setCollapsedSourceGroups((current) => ({ ...current, [groupId]: !current[groupId] }))}
        onEditSource={openSourceSettings}
        onOpenSettings={() => setAppView("settings")}
      />
      <Timeline
        loadingEntries={loadingEntries}
        loadFailed={entryLoadFailed}
        onReload={() => void reload().catch(() => undefined)}
        onAddSource={openAddSource}
        activeSource={activeSource}
        libraryView={libraryView}
        entrySearch={entrySearch}
        entries={entries}
        hasMoreEntries={hasMoreEntries}
        loadingMoreEntries={loadingMoreEntries}
        paginationError={paginationError}
        sourceById={sourceById}
        readingEntryId={readingEntry?.id}
        notice={reloadError ?? notice?.message}
        busy={busy}
        onUndo={notice && undoEntry && !reloadError ? () => void restoreEntry(undoEntry, notice.id) : undefined}
        onEditSource={openSourceSettings}
        onClearNotice={() => { setNotice(undefined); clearReloadError(); }}
        onEntrySearchChange={setEntrySearch}
        onUpdateEntry={updateEntry}
        isEntryUpdating={isEntryUpdating}
        onOpenEntry={openReader}
        onDismissEntry={dismissEntry}
        onLoadMore={() => void loadMoreEntries()}
      />
      {readingEntry ? <ReaderView
        entry={readingEntry}
        source={sourceById.get(readingEntry.sourceId)}
        onUpdateEntry={updateEntry}
        favoriteUpdating={isEntryUpdating(readingEntry.id, "favorite")}
        readerOnly={readerOnly}
        onToggleReaderOnly={() => setReaderOnly((current) => !current)}
        onOpenSettings={() => setAppView("settings")}
      /> : <ReaderPlaceholder />}

      {pending && <PreviewDialog key={pending.token} pending={pending} onCancel={() => setPending(undefined)} onConfirm={confirm} />}
      {addSourceSession && <AddSourceDialog
        key={addSourceSession}
        onClose={() => closeAddSource(addSourceSession)}
        onPreview={acceptPreview}
        onImportOpml={importOpml}
        onZhihuStarted={() => finishSourceAddition(addSourceSession, "已打开知乎登录窗口；登录完成后会自动同步关注动态。")}
        onXStarted={() => finishSourceAddition(addSourceSession, "X 已授权，正在同步关注账号的原创帖子。")}
        onXiaohongshuSaved={() => finishSourceAddition(addSourceSession, "小红书公开博主来源已添加，正在读取公开笔记。")}
        onAcademicSaved={() => finishSourceAddition(addSourceSession, "学术作者来源已添加，正在同步公开论文记录。")}
      />}
      {sourceDialog?.mode === "calibration" && <CalibrationDialog
        key={sourceDialog.token}
        source={sourceDialog.source}
        onClose={() => closeSourceDialog(sourceDialog.token)}
        onSaved={() => finishSourceManagement(sourceDialog.token)}
      />}
      {sourceDialog?.mode === "settings" && <SourceSettingsDialog
        key={sourceDialog.token}
        source={sourceDialog.source}
        onClose={() => closeSourceDialog(sourceDialog.token)}
        onSaved={() => finishSourceManagement(sourceDialog.token)}
        onRefresh={() => refresh(sourceDialog.source)}
        onCalibrate={() => setSourceDialog((current) => current?.token === sourceDialog.token
          ? { ...current, token: crypto.randomUUID(), mode: "calibration" } : current)}
        onDelete={async () => { await toggleSourceSubscription(sourceDialog.source); closeSourceDialog(sourceDialog.token); }}
        onReconnectZhihu={async () => { await window.reader.connectZhihuFollow(); setNotice("已打开知乎登录窗口；登录完成后会自动同步。"); }}
      />}
    </main>
  );
}
