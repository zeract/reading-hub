import { useCallback, useEffect, useState } from "react";
import type { Entry, OpmlImportResult, ProbeResult, Source } from "../shared/types";
import { errorMessage } from "./errors";
import { Timeline, SourceSidebar } from "./library-pane";
import type { LibraryView } from "./library-view";
import { ReaderPlaceholder, ReaderView } from "./reader-view";
import { SettingsView } from "./settings-view";
import { AddSourceDialog, CalibrationDialog, isRetiredXPublicProfile, PreviewDialog, SourceSettingsDialog } from "./source-dialogs";
import { AppIcon } from "./ui-icons";
import { useLibraryData } from "./use-library-data";

type PendingPreview = { token: string; probe: ProbeResult };
type AppView = "library" | "settings";

/**
 * The application shell owns cross-feature state and coordinates safe IPC
 * calls. Feature views remain independently testable and never reach across
 * one another for state.
 */
export function App() {
  const {
    sources,
    entries,
    libraryCounts,
    activeSourceId,
    libraryView,
    sourceById,
    activeSource,
    sourceGroups,
    reload,
    selectSource: selectLibrarySource,
    selectLibrary: selectLibraryView,
    clearActiveSource
  } = useLibraryData();
  const [pending, setPending] = useState<PendingPreview>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [activeRuleSource, setActiveRuleSource] = useState<Source>();
  const [editingSource, setEditingSource] = useState<Source>();
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
    if (!readingEntry) setReaderOnly(false);
  }, [readingEntry]);

  const preview = useCallback(async (url: string) => {
    if (!url.trim()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      setPending(await window.reader.previewSource(url.trim()));
      setShowAddSource(false);
    } catch (error) {
      setNotice(errorMessage(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }, []);

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
    setBusy(true);
    try {
      const source = await window.reader.confirmSource(pending.token);
      setPending(undefined);
      setNotice(source.status === "needs_review" ? "已保存，但需要校正提取规则后才会自动刷新。" : "来源已添加。");
      await reload();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [pending, reload]);

  const refresh = useCallback(async (source: Source) => {
    setBusy(true);
    try {
      await window.reader.refreshSource(source.id);
      await reload();
      setNotice(`已检查「${source.title}」。`);
    } catch (error) {
      await reload();
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
    if (!entry.read) void updateEntry(entry, "read", true);
  }, [updateEntry]);

  const selectSource = useCallback((sourceId?: string) => {
    setReadingEntry(undefined);
    selectLibrarySource(sourceId);
  }, [selectLibrarySource]);

  const selectLibrary = useCallback((view: LibraryView) => {
    setReadingEntry(undefined);
    selectLibraryView(view);
  }, [selectLibraryView]);

  const deleteSource = useCallback(async (source: Source): Promise<boolean> => {
    if (!window.confirm(`删除「${source.title}」及其已收集内容？此操作无法撤销。`)) return false;
    setBusy(true);
    try {
      await window.reader.deleteSource(source.id);
      if (activeSourceId === source.id) clearActiveSource();
      if (readingEntry?.sourceId === source.id) setReadingEntry(undefined);
      setNotice(`已删除「${source.title}」。`);
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
    if (!window.confirm(`删除收集的「${entry.title}」？该内容不会在后续同步中再次出现。`)) return;
    setBusy(true);
    try {
      await window.reader.dismissEntry(entry.id);
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
          {!readerOnly && <button type="button" className="app-titlebar-button" onClick={refreshCurrentView} disabled={busy || isRetiredXPublicProfile(activeSource)} aria-label={activeSource ? `刷新 ${activeSource.title}` : "重新载入收件箱"} title={isRetiredXPublicProfile(activeSource) ? "此旧 X 公开来源已停止刷新" : activeSource ? "刷新当前来源" : "重新载入收件箱"}><AppIcon name="refresh" /></button>}
          {!readerOnly && <button type="button" className="app-titlebar-button app-titlebar-add" onClick={() => setShowAddSource(true)} aria-label="添加来源" title="添加来源"><AppIcon name="add" /></button>}
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
        onEditSource={setEditingSource}
        onOpenSettings={() => setAppView("settings")}
      />
      <Timeline
        activeSource={activeSource}
        libraryView={libraryView}
        entries={entries}
        sourceById={sourceById}
        readingEntryId={readingEntry?.id}
        notice={notice}
        busy={busy}
        libraryCounts={libraryCounts}
        onClearNotice={() => setNotice(undefined)}
        onUpdateEntry={updateEntry}
        onOpenEntry={openReader}
        onDismissEntry={dismissEntry}
      />
      {readingEntry ? <ReaderView
        entry={readingEntry}
        source={sourceById.get(readingEntry.sourceId)}
        onUpdateEntry={updateEntry}
        readerOnly={readerOnly}
        onToggleReaderOnly={() => setReaderOnly((current) => !current)}
        onOpenSettings={() => setAppView("settings")}
      /> : <ReaderPlaceholder />}

      {pending && <PreviewDialog pending={pending} onCancel={() => setPending(undefined)} onConfirm={() => void confirm()} busy={busy} />}
      {showAddSource && <AddSourceDialog
        onClose={() => setShowAddSource(false)}
        onPreview={preview}
        onImportOpml={importOpml}
        onZhihuStarted={async () => { setShowAddSource(false); setNotice("已打开知乎登录窗口；登录完成后会自动同步关注动态。"); await reload(); }}
        onXStarted={async () => { setShowAddSource(false); setNotice("X 已授权，正在同步关注账号的原创帖子。"); await reload(); }}
        onXiaohongshuSaved={async () => { setShowAddSource(false); setNotice("小红书公开博主来源已添加，正在读取公开笔记。"); await reload(); }}
        onAcademicSaved={async () => { setShowAddSource(false); setNotice("学术作者来源已添加，正在同步公开论文记录。"); await reload(); }}
      />}
      {activeRuleSource && <CalibrationDialog source={activeRuleSource} onClose={() => setActiveRuleSource(undefined)} onSaved={async () => { setActiveRuleSource(undefined); await reload(); }} />}
      {editingSource && <SourceSettingsDialog
        source={editingSource}
        onClose={() => setEditingSource(undefined)}
        onSaved={async () => { setEditingSource(undefined); await reload(); }}
        onRefresh={() => refresh(editingSource)}
        onCalibrate={() => { setEditingSource(undefined); setActiveRuleSource(editingSource); }}
        onDelete={async () => { if (await deleteSource(editingSource)) setEditingSource(undefined); }}
        onReconnectZhihu={async () => { await window.reader.connectZhihuFollow(); setNotice("已打开知乎登录窗口；登录完成后会自动同步。"); }}
      />}
    </main>
  );
}
