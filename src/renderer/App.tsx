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

type AppView = "library" | "settings";
type SourceDialogSession = { token: string; mode: "settings" | "calibration"; source: Source };

/**
 * The application shell owns cross-feature state and coordinates safe IPC
 * calls. Feature views remain independently testable and never reach across
 * one another for state.
 */
export function App() {
  const {
    sources,
    entries,
    hasMoreEntries,
    loadingMoreEntries,
    reloadError,
    clearReloadError,
    libraryCounts,
    activeSourceId,
    libraryView,
    entrySearch,
    sourceById,
    activeSource,
    sourceGroups,
    reload,
    loadMoreEntries,
    selectSource: selectLibrarySource,
    selectLibrary: selectLibraryView,
    setEntrySearch,
    clearActiveSource
  } = useLibraryData();
  const [pending, setPending] = useState<PendingPreview>();
  const [notice, setNotice] = useState<string>();
  const [deletedEntry, setDeletedEntry] = useState<Entry>();
  const [busy, setBusy] = useState(false);
  const [addSourceSession, setAddSourceSession] = useState<string>();
  const [sourceDialog, setSourceDialog] = useState<SourceDialogSession>();
  const [collapsedSourceGroups, setCollapsedSourceGroups] = useState<Record<string, boolean>>({});
  const [readingEntry, setReadingEntry] = useState<Entry>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [readerOnly, setReaderOnly] = useState(false);
  const [appView, setAppView] = useState<AppView>("library");
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.reader.onWindowFullscreenChange(setWindowFullscreen);
    void window.reader.isWindowFullscreen().then((fullscreen) => {
      if (mounted) setWindowFullscreen(fullscreen);
    }).catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setSourceDialog((current) => {
      if (!current) return current;
      const source = sources.find((item) => item.id === current.source.id);
      return source ? { ...current, source } : undefined;
    });
  }, [sources]);

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
  }, []);

  const closeAddSource = useCallback((session: string) => {
    setAddSourceSession((current) => current === session ? undefined : current);
  }, []);

  const finishSourceAddition = useCallback(async (session: string, message: string) => {
    closeAddSource(session);
    setNotice(message);
    await reload();
  }, [closeAddSource, reload]);

  const importOpml = useCallback(async (): Promise<OpmlImportResult> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await window.reader.importOpml();
      if (!result.cancelled) {
        const details = [`导入 ${result.imported} 个 Feed`];
        if (result.existing) details.push(`${result.existing} 个已存在`);
        if (result.skipped) details.push(`${result.skipped} 个无效或不支持`);
        setNotice(`${details.join("；")}。正在按安全限流初始化同步。`);
        await reload();
      }
      return result;
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      throw error;
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const source = await window.reader.confirmSource(pending.token);
    setPending((current) => current?.token === pending.token ? undefined : current);
    setNotice(source.status === "needs_review" ? "已保存，但需要校正提取规则后才会自动刷新。" : "来源已添加。");
    await reload();
  }, [pending, reload]);

  const refresh = useCallback(async (source: Source) => {
    setBusy(true);
    try {
      await window.reader.refreshSource(source.id);
      await reload();
      setNotice(`已检查「${source.title}」。`);
    } catch (error) {
      await reload().catch(() => undefined);
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const updateEntry = useCallback(async (entry: Entry, field: "read" | "favorite", value: boolean): Promise<boolean> => {
    try {
      if (field === "read") await window.reader.markRead(entry.id, value);
      else await window.reader.markFavorite(entry.id, value);
      setReadingEntry((current) => current?.id === entry.id ? { ...current, [field]: value } : current);
      await reload();
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [reload]);

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

  const deleteSource = useCallback(async (source: Source): Promise<boolean> => {
    setBusy(true);
    try {
      await window.reader.setSourceSubscribed(source.id, source.subscribed === false);
      if (activeSourceId === source.id) clearActiveSource();
      setNotice(source.subscribed === false ? `已重新订阅「${source.title}」。` : `已取消订阅「${source.title}」，已有内容与收藏已保留。`);
      await reload();
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [activeSourceId, clearActiveSource, readingEntry?.sourceId, reload]);

  const dismissEntry = useCallback(async (entry: Entry) => {
    setBusy(true);
    try {
      await window.reader.dismissEntry(entry.id);
      setDeletedEntry(entry);
      if (readingEntry?.id === entry.id) setReadingEntry(undefined);
      setNotice(`已删除「${entry.title}」。`);
      await reload();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [readingEntry?.id, reload]);

  const refreshCurrentView = useCallback(() => {
    if (activeSource) {
      if (isRetiredXPublicProfile(activeSource)) {
        setNotice("此旧 X 公开来源已停止刷新：X 没有提供可合规自动读取的公开订阅接口。可保留已有卡片，或删除来源后使用官方 API。");
        return;
      }
      void refresh(activeSource);
      return;
    }
    void reload().then(() => setNotice("已重新载入收件箱。")).catch((error) => setNotice(errorMessage(error)));
  }, [activeSource, refresh, reload]);

  if (appView === "settings") {
    return <SettingsView onClose={() => setAppView("library")} windowFullscreen={windowFullscreen} />;
  }

  return (
    <main className={`shell${sidebarCollapsed ? " shell--sidebar-collapsed" : ""}${readerOnly ? " shell--reader-only" : ""}${windowFullscreen ? " shell--fullscreen" : ""}`}>
      <header className="app-titlebar">
        <div className="app-titlebar-actions">
          <button type="button" className="app-titlebar-button" onClick={() => readerOnly ? setReaderOnly(false) : setSidebarCollapsed((collapsed) => !collapsed)} aria-label={readerOnly ? "退出沉浸阅读" : sidebarCollapsed ? "显示来源边栏" : "隐藏来源边栏"} title={readerOnly ? "退出沉浸阅读" : sidebarCollapsed ? "显示来源边栏" : "隐藏来源边栏"}><AppIcon name={readerOnly ? "expand" : "sidebar"} /></button>
          {!readerOnly && <button type="button" className="app-titlebar-button" onClick={refreshCurrentView} disabled={busy || Boolean(activeSource && !sourceCapabilities(activeSource).canRefresh)} aria-label={activeSource ? `刷新 ${activeSource.title}` : "重新载入收件箱"} title={isRetiredXPublicProfile(activeSource) ? "此旧 X 公开来源已停止刷新" : activeSource ? "刷新当前来源" : "重新载入收件箱"}><AppIcon name="refresh" /></button>}
          {!readerOnly && <button type="button" className="app-titlebar-button app-titlebar-add" onClick={() => setAddSourceSession(crypto.randomUUID())} aria-label="添加来源" title="添加来源"><AppIcon name="add" /></button>}
        </div>
      </header>
      <SourceSidebar
        sources={sources}
        groups={sourceGroups}
        libraryView={libraryView}
        activeSourceId={activeSourceId}
        libraryCounts={libraryCounts}
        collapsedGroups={collapsedSourceGroups}
        onSelectLibrary={selectLibrary}
        onSelectSource={selectSource}
        onToggleGroup={(groupId) => setCollapsedSourceGroups((current) => ({ ...current, [groupId]: !current[groupId] }))}
        onEditSource={openSourceSettings}
        onOpenSettings={() => setAppView("settings")}
      />
      <Timeline
        activeSource={activeSource}
        libraryView={libraryView}
        entrySearch={entrySearch}
        entries={entries}
        hasMoreEntries={hasMoreEntries}
        loadingMoreEntries={loadingMoreEntries}
        sourceById={sourceById}
        readingEntryId={readingEntry?.id}
        notice={reloadError ?? notice}
        busy={busy}
        onUndo={deletedEntry && notice === `已删除「${deletedEntry.title}」。` && !reloadError ? () => {
          setBusy(true);
          void window.reader.restoreEntry(deletedEntry.id).then(async () => {
            setDeletedEntry(undefined); setNotice("内容已恢复。"); await reload();
          }).catch((error) => setNotice(errorMessage(error))).finally(() => setBusy(false));
        } : undefined}
        onRestoreEntry={async (entry) => {
          setBusy(true);
          try { await window.reader.restoreEntry(entry.id); setDeletedEntry(undefined); setNotice("内容已恢复。"); await reload(); }
          catch (error) { setNotice(errorMessage(error)); }
          finally { setBusy(false); }
        }}
        onEditSource={openSourceSettings}
        onClearNotice={() => { setNotice(undefined); setDeletedEntry(undefined); clearReloadError(); }}
        onEntrySearchChange={setEntrySearch}
        onUpdateEntry={updateEntry}
        onOpenEntry={openReader}
        onDismissEntry={dismissEntry}
        onLoadMore={() => void loadMoreEntries().catch((error) => setNotice(errorMessage(error)))}
      />
      {readingEntry ? <ReaderView
        entry={readingEntry}
        source={sourceById.get(readingEntry.sourceId)}
        onUpdateEntry={updateEntry}
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
        onDelete={async () => { if (await deleteSource(sourceDialog.source)) closeSourceDialog(sourceDialog.token); }}
        onReconnectZhihu={async () => { await window.reader.connectZhihuFollow(); setNotice("已打开知乎登录窗口；登录完成后会自动同步。"); }}
      />}
    </main>
  );
}
