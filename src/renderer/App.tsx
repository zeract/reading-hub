import { type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CODEX_CLI_MODEL_OPTIONS, type AiProviderId, type AiProviderSettings, type AiReasoningEffort, type AiSelectionContext, type AiSelectionIntent, type CalibrationResult, type Entry, type LibraryCounts, type OpmlImportResult, type ProbeResult, type ReaderArticle, type Source, type SourceKind, type SubscriptionDraft } from "../shared/types";
import { AiMarkdownContent } from "./ai-markdown";
import { shouldSubmitAssistantQuestion } from "./assistant-input";
import { entryQueryForLibrary, type LibraryView } from "./library-view";
import { requiresSourceReload } from "./source-selection";
import { groupSources } from "./source-groups";
import { normaliseSelectedArticleText, selectedTextLabel, selectionActionQuestion, selectionContext, selectionOverlay, type SelectionOverlay, type SelectionRect } from "./selection-actions";

type PendingPreview = { token: string; probe: ProbeResult };
type ReaderPreset = "reading" | "compact";
type ReaderPreferences = { preset: ReaderPreset; fontScale: number };
type AddSourceMethod = "public" | "zhihu" | "x" | "xiaohongshu" | "academic";
type AssistantPanelState = "closed" | "minimized" | "open";
type AppView = "library" | "settings";
type ReaderImagePreview = { src: string; alt: string };
type ReaderTextSelection = { text: string; overlay: SelectionOverlay; asking: boolean; request?: AssistantSelectionRequest };
type AssistantSelectionRequest = { id: string; question: string; selection: AiSelectionContext };

const READER_PREFERENCES_KEY = "reading-hub.reader-preferences.v1";
const DEFAULT_READER_PREFERENCES: ReaderPreferences = { preset: "reading", fontScale: 1 };
const EMPTY_LIBRARY_COUNTS: LibraryCounts = { unread: 0, favorite: 0, today: 0 };

function newAiRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // This id only pairs same-renderer IPC events; it is never an auth token.
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function toSelectionRect(rect: DOMRect): SelectionRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function loadReaderPreferences(): ReaderPreferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(READER_PREFERENCES_KEY) || "{}") as Partial<ReaderPreferences>;
    const preset: ReaderPreset = stored.preset === "compact" ? "compact" : "reading";
    const fontScale = typeof stored.fontScale === "number" && stored.fontScale >= 0.85 && stored.fontScale <= 1.25
      ? stored.fontScale
      : DEFAULT_READER_PREFERENCES.fontScale;
    return { preset, fontScale };
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
}

export function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [libraryCounts, setLibraryCounts] = useState<LibraryCounts>(EMPTY_LIBRARY_COUNTS);
  const [pending, setPending] = useState<PendingPreview>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [activeRuleSource, setActiveRuleSource] = useState<Source>();
  const [editingSource, setEditingSource] = useState<Source>();
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [libraryView, setLibraryView] = useState<LibraryView>("today");
  const [collapsedSourceGroups, setCollapsedSourceGroups] = useState<Record<string, boolean>>({});
  const [readingEntry, setReadingEntry] = useState<Entry>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [readerOnly, setReaderOnly] = useState(false);
  const [appView, setAppView] = useState<AppView>("library");
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const reloadSequence = useRef(0);

  const entriesQuery = useMemo(() => entryQueryForLibrary(libraryView, activeSourceId), [activeSourceId, libraryView]);

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

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const [nextSources, nextEntries, nextLibraryCounts] = await Promise.all([
      window.reader.listSources(),
      window.reader.listEntries(entriesQuery),
      window.reader.getLibraryCounts()
    ]);
    // A source or time-range change may have started a newer request while an
    // older IPC call was still in flight. Never replace the newest result.
    if (sequence !== reloadSequence.current) return;
    setSources(nextSources);
    setEntries(nextEntries);
    setLibraryCounts(nextLibraryCounts);
  }, [entriesQuery]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!readingEntry) setReaderOnly(false);
  }, [readingEntry]);

  async function preview(url: string) {
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
  }

  async function importOpml(): Promise<OpmlImportResult> {
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
  }

  async function confirm() {
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
  }

  async function refresh(source: Source) {
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
  }

  async function updateEntry(entry: Entry, field: "read" | "favorite", value: boolean): Promise<boolean> {
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
  }

  function openReader(entry: Entry) {
    setReadingEntry(entry);
    if (!entry.read) void updateEntry(entry, "read", true);
  }

  function selectSource(sourceId?: string) {
    setReadingEntry(undefined);
    setLibraryView("all");
    if (requiresSourceReload(activeSourceId, sourceId)) {
      // A repeated click does not change `activeSourceId`, so the effect that
      // normally reloads entries would not run. Do not leave the cleared list
      // on screen; fetch the current source explicitly instead.
      void reload();
      return;
    }
    setEntries([]);
    setActiveSourceId(sourceId);
  }

  function selectLibrary(view: LibraryView) {
    setReadingEntry(undefined);
    setActiveSourceId(undefined);
    setLibraryView(view);
    setEntries([]);
  }

  async function deleteSource(source: Source): Promise<boolean> {
    if (!window.confirm(`删除「${source.title}」及其已收集内容？此操作无法撤销。`)) return false;
    setBusy(true);
    try {
      await window.reader.deleteSource(source.id);
      if (activeSourceId === source.id) setActiveSourceId(undefined);
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
  }

  async function dismissEntry(entry: Entry) {
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
  }

  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const activeSource = activeSourceId ? sourceById.get(activeSourceId) : undefined;
  const sourceGroups = useMemo(() => groupSources(sources), [sources]);
  const visibleEntries = useMemo(() => entries.filter((entry) => {
    if (libraryView === "unread") return !entry.read;
    if (libraryView === "favorite") return entry.favorite;
    return true;
  }), [entries, libraryView]);
  const libraryTitle = activeSource?.title || ({ all: "最新文章", today: "今日更新", unread: "未读文章", favorite: "收藏文章" } satisfies Record<LibraryView, string>)[libraryView];
  const unreadCount = libraryCounts.unread;
  const timelineCount = activeSource
    ? { value: entries.length, label: "篇内容" }
    : libraryView === "today"
      ? { value: libraryCounts.today, label: "篇更新" }
      : libraryView === "favorite"
        ? { value: libraryCounts.favorite, label: "篇收藏" }
      : { value: unreadCount, label: "未读" };

  function refreshCurrentView() {
    if (activeSource) {
      if (isRetiredXPublicProfile(activeSource)) {
        setNotice("此旧 X 公开来源已停止刷新：X 没有提供可合规自动读取的公开订阅接口。可保留已有卡片，或删除来源后使用官方 API。");
        return;
      }
      void refresh(activeSource);
      return;
    }
    void reload().then(() => setNotice("已重新载入收件箱。")).catch((error) => setNotice(errorMessage(error)));
  }

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
      <aside className="sidebar">
        <nav className="library-nav" aria-label="阅读分类">
          <div className="section-title">阅读</div>
          <button className={`library-filter ${libraryView === "today" && !activeSourceId ? "selected" : ""}`} onClick={() => selectLibrary("today")}><span><AppIcon name="today" />今日</span></button>
          <button className={`library-filter ${libraryView === "unread" && !activeSourceId ? "selected" : ""}`} onClick={() => selectLibrary("unread")}><span><AppIcon name="unread" />未读</span><em>{unreadCount}</em></button>
          <button className={`library-filter ${libraryView === "favorite" && !activeSourceId ? "selected" : ""}`} onClick={() => selectLibrary("favorite")}><span><AppIcon name="favorite" />收藏</span><em>{libraryCounts.favorite}</em></button>
        </nav>
        <section className="source-section" aria-labelledby="source-heading">
          <div className="section-title" id="source-heading">来源 <span>{sources.length}</span></div>
          <div className="source-list">
            {sourceGroups.map((group) => <section className="source-group" key={group.id}>
              <button type="button" className="source-group-heading" onClick={() => setCollapsedSourceGroups((current) => ({ ...current, [group.id]: !current[group.id] }))} aria-expanded={!collapsedSourceGroups[group.id]}>
                <span className="source-group-label"><AppIcon name={collapsedSourceGroups[group.id] ? "chevron-right" : "chevron-down"} /><AppIcon name="folder" /><span>{group.title}</span></span><em>{group.sources.length}</em>
              </button>
              {!collapsedSourceGroups[group.id] && group.sources.map((source) => (
                <div className="source-row" key={source.id} onContextMenu={(event) => { event.preventDefault(); setEditingSource(source); }}>
                  <button className={`source-filter ${activeSourceId === source.id ? "selected" : ""}`} onClick={() => selectSource(source.id)} onKeyDown={(event) => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      setEditingSource(source);
                    }
                  }} title={`${source.title}（右键配置）`} aria-label={`查看 ${source.title}；右键打开来源设置`}>
                    <SourceIcon source={source} /><span className="source-title">{source.title}</span>
                  </button>
                </div>
              ))}
            </section>)}
            {!sources.length && <p className="empty-side">先添加一个公开 Feed 或网页。</p>}
          </div>
        </section>
        <footer className="sidebar-footer"><button type="button" className="sidebar-settings-button" onClick={() => setAppView("settings")} aria-label="打开设置" title="设置"><AppIcon name="settings" /><span>设置</span></button></footer>
      </aside>

      <section className="timeline" aria-label="文章列表">
        <header><div><p className="eyebrow">{activeSource ? "来源内容" : "阅读收件箱"}</p><h1>{libraryTitle}</h1></div><span className="count">{timelineCount.value} {timelineCount.label}</span></header>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice(undefined)}>×</button></div>}
        <div className="entry-list">
          {visibleEntries.map((entry) => <EntryCard key={entry.id} entry={entry} source={sourceById.get(entry.sourceId)} selected={readingEntry?.id === entry.id} onRead={updateEntry} onOpen={openReader} onDismiss={dismissEntry} busy={busy} />)}
          {!visibleEntries.length && <div className="empty-state"><p className="eyebrow">READING DESK / 00</p><h2>{activeSource ? "该来源还没有内容" : libraryView === "today" ? "今天还没有更新" : libraryView === "unread" ? "没有未读文章" : libraryView === "favorite" ? "还没有收藏文章" : "还没有内容"}</h2><p>{activeSource ? "可以刷新来源，或使用“自动校准”重新识别内容列表。" : "添加 RSS、公开文章列表页，或粘贴小红书分享链接开始。"}</p></div>}
        </div>
      </section>
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

function EntryCard({ entry, source, selected, onRead, onOpen, onDismiss, busy }: { entry: Entry; source?: Source; selected: boolean; onRead: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>; onOpen: (entry: Entry) => void; onDismiss: (entry: Entry) => Promise<void>; busy: boolean }) {
  const date = entry.publishedAt
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.publishedAt)
    : entry.observedAt ? `收集于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.observedAt)}` : "刚刚收集";
  const providers = [...new Set((entry.origins || []).map((origin) => origin.providerLabel || origin.providerId).filter((id) => id !== source?.connectorId))];
  return <article className={`entry-card ${entry.read ? "read" : ""}${selected ? " selected" : ""}`}>
    <button className="entry-main" type="button" onClick={() => onOpen(entry)} aria-label={`在应用内阅读：${entry.title}`}>
      <div className="entry-copy"><p className="entry-source">{source?.title || "已保存内容"} <span>·</span> {date}{providers.length ? <><span>·</span>{providers.join(" / ")}</> : null}</p><h2>{entry.title}</h2>{entry.summary && <p className="summary">{entry.summary}</p>}<p className="byline">{entry.author || "原文链接"}</p></div>
      {entry.imageUrl && <img src={entry.imageUrl} alt="" loading="lazy" />}
    </button>
    <div className="entry-actions"><button type="button" onClick={() => onOpen(entry)}>应用内阅读</button><button aria-label="标记已读" onClick={() => void onRead(entry, "read", !entry.read)}>{entry.read ? "未读" : "已读"}</button><button aria-label="收藏" onClick={() => void onRead(entry, "favorite", !entry.favorite)}>{entry.favorite ? "★" : "☆"}</button><button type="button" className="delete-entry" onClick={() => void onDismiss(entry)} disabled={busy}>删除</button></div>
  </article>;
}

function ReaderPlaceholder() {
  return <section className="reader-placeholder" aria-label="选择文章开始阅读">
    <div className="reader-placeholder-mark">RH<br /><span>01</span></div>
    <div><p className="eyebrow">YOUR READING DESK</p><h2>选择一篇文章<br />开始阅读</h2><p>来源、时间与阅读状态会保留在本机。<br />正文始终来自原始发布者。</p></div>
  </section>;
}

function ReaderView({ entry, source, onUpdateEntry, readerOnly, onToggleReaderOnly, onOpenSettings }: {
  entry: Entry;
  source?: Source;
  onUpdateEntry: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>;
  readerOnly: boolean;
  onToggleReaderOnly: () => void;
  onOpenSettings: () => void;
}) {
  const [article, setArticle] = useState<ReaderArticle>();
  const [embedded, setEmbedded] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadReaderPreferences);
  const [assistantState, setAssistantState] = useState<AssistantPanelState>("closed");
  const [imagePreview, setImagePreview] = useState<ReaderImagePreview>();
  const [textSelection, setTextSelection] = useState<ReaderTextSelection>();
  const [selectionQuestion, setSelectionQuestion] = useState("");
  const [preferredAiProviderId, setPreferredAiProviderId] = useState<AiProviderId>("codex-cli");
  const [favoriteUpdating, setFavoriteUpdating] = useState(false);
  const articleBodyElement = useRef<HTMLDivElement>(null);
  const readerWorkspaceElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.localStorage.setItem(READER_PREFERENCES_KEY, JSON.stringify(preferences));
  }, [preferences]);
  const loadArticle = useCallback(async () => {
    setLoading(true); setError(undefined); setArticle(undefined); setEmbedded(false);
    try {
      const result = await window.reader.readEntry(entry.id);
      if (result.kind === "article") setArticle(result.article);
      else setEmbedded(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [entry.id]);
  useEffect(() => { void loadArticle(); }, [loadArticle]);
  useEffect(() => {
    setAssistantState("closed");
    setImagePreview(undefined);
    setTextSelection(undefined);
    setSelectionQuestion("");
  }, [entry.id]);
  useEffect(() => {
    if (!imagePreview && !textSelection) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setImagePreview(undefined);
        setTextSelection(undefined);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [imagePreview, textSelection]);

  const displayed = article || entry;
  const date = displayed.publishedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(displayed.publishedAt) : undefined;
  function previewImage(image: HTMLImageElement) {
    const src = image.currentSrc || image.src;
    if (src) setImagePreview({ src, alt: image.alt || "文章图片" });
  }
  function handleContentClick(event: SyntheticEvent<HTMLElement>) {
    const target = event.target;
    const image = target instanceof HTMLImageElement
      ? target
      : target instanceof Element ? target.closest("img[data-reader-zoomable='true']") : null;
    if (image instanceof HTMLImageElement) {
      event.preventDefault();
      previewImage(image);
      return;
    }
    const link = target instanceof Element ? target.closest("a[href]") as HTMLAnchorElement | null : null;
    if (!link) return;
    event.preventDefault();
    setTextSelection(undefined);
    void window.reader.openExternal(link.href);
  }
  function handleContentKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    const image = target instanceof HTMLImageElement
      ? target
      : target instanceof Element ? target.closest("img[data-reader-zoomable='true']") : null;
    if (!(image instanceof HTMLImageElement)) return;
    event.preventDefault();
    previewImage(image);
  }
  function captureArticleSelection() {
    const root = articleBodyElement.current;
    const workspace = readerWorkspaceElement.current;
    const selection = window.getSelection();
    if (!root || !workspace || !selection || selection.isCollapsed || !selection.rangeCount) {
      setTextSelection(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setTextSelection(undefined);
      return;
    }
    const text = normaliseSelectedArticleText(selection.toString());
    const frame = toSelectionRect(workspace.getBoundingClientRect());
    const overlay = selectionOverlay(Array.from(range.getClientRects()).map(toSelectionRect), frame);
    if (!text || !overlay) {
      setTextSelection(undefined);
      return;
    }
    // A text selection starts an in-context reading flow. Keep its anchor and
    // answer unobscured instead of competing with an already-open side panel.
    setAssistantState((state) => state === "open" ? "minimized" : state);
    setSelectionQuestion("");
    setTextSelection({ text, overlay, asking: false });
  }
  function askAboutSelection(intent: Exclude<AiSelectionIntent, "ask">) {
    if (!textSelection) return;
    const question = selectionActionQuestion(intent);
    if (!question) return;
    window.getSelection()?.removeAllRanges();
    setTextSelection((current) => current ? { ...current, asking: false, request: { id: newAiRequestId(), question, selection: selectionContext(current.text, intent) } } : current);
  }
  function revealSelectionQuestion() {
    setTextSelection((current) => current ? { ...current, asking: true, request: undefined } : current);
  }
  function submitSelectionQuestion(event: FormEvent) {
    event.preventDefault();
    if (!textSelection) return;
    const question = selectionActionQuestion("ask", selectionQuestion);
    if (!question) return;
    window.getSelection()?.removeAllRanges();
    setTextSelection((current) => current ? { ...current, asking: false, request: { id: newAiRequestId(), question, selection: selectionContext(current.text, "ask") } } : current);
    setSelectionQuestion("");
  }
  function clearTextSelection() {
    window.getSelection()?.removeAllRanges();
    setTextSelection(undefined);
    setSelectionQuestion("");
  }
  function handleContentError(event: SyntheticEvent<HTMLElement>) {
    const image = event.target instanceof HTMLImageElement ? event.target : undefined;
    if (!image) return;
    const originalUrl = image.currentSrc || image.src;
    if (!originalUrl || image.dataset.readerProxyTried === "1") {
      replaceBrokenImage(image);
      return;
    }
    image.dataset.readerProxyTried = "1";
    void window.reader.loadArticleImage(entry.id, originalUrl)
      .then((dataUrl) => { image.src = dataUrl; })
      .catch(() => replaceBrokenImage(image));
  }
  function replaceBrokenImage(image: HTMLImageElement) {
    if (!image.isConnected || image.dataset.readerImageUnavailable === "1") return;
    image.dataset.readerImageUnavailable = "1";
    const fallback = document.createElement("a");
    fallback.href = entry.url;
    fallback.className = "reader-image-failure";
    fallback.textContent = "图片未能加载 · 在浏览器中查看原文";
    image.replaceWith(fallback);
  }
  function openEmbedded() {
    void window.reader.openEmbeddedEntry(entry.id).catch((reason) => setError(errorMessage(reason)));
  }
  async function toggleFavorite() {
    if (favoriteUpdating) return;
    setFavoriteUpdating(true);
    try {
      await onUpdateEntry(entry, "favorite", !entry.favorite);
    } finally {
      setFavoriteUpdating(false);
    }
  }

  const readerStyle = { "--reader-font-scale": String(preferences.fontScale) } as CSSProperties & Record<"--reader-font-scale", string>;
  const setPreset = (preset: ReaderPreset) => setPreferences((current) => ({ ...current, preset }));
  const adjustFont = (amount: number) => setPreferences((current) => ({
    ...current,
    fontScale: Math.min(1.25, Math.max(0.85, Number((current.fontScale + amount).toFixed(2))))
  }));
  const toggleAssistant = () => {
    if (!article) return;
    setAssistantState((state) => state === "open" ? "minimized" : "open");
  };
  const assistantVisible = assistantState === "open";
  const assistantMounted = assistantState !== "closed";

  return <section className={`reader-view reader--${article?.renderProfile || "standard"}`} data-reader-preset={preferences.preset} style={readerStyle} aria-label="应用内阅读器">
    <header className="reader-toolbar">
      <div className="reader-toolbar-spacer" aria-hidden="true" />
      <div className="reader-toolbar-center">
        <p>{source?.title || "已保存内容"}</p>
        <div className="reader-controls" aria-label="阅读排版设置">
          <button type="button" className={preferences.preset === "compact" ? "selected" : ""} aria-pressed={preferences.preset === "compact"} onClick={() => setPreset("compact")}>紧凑</button>
          <button type="button" className={preferences.preset === "reading" ? "selected" : ""} aria-pressed={preferences.preset === "reading"} onClick={() => setPreset("reading")}>阅读</button>
          <span aria-hidden="true" />
          <button type="button" aria-label="缩小字号" disabled={preferences.fontScale <= 0.85} onClick={() => adjustFont(-0.05)}>A−</button>
          <button type="button" aria-label="放大字号" disabled={preferences.fontScale >= 1.25} onClick={() => adjustFont(0.05)}>A+</button>
        </div>
      </div>
      <div className="reader-toolbar-actions">
        <button type="button" className={`toolbar-icon-button favorite-button${entry.favorite ? " is-favorite" : ""}`} aria-pressed={entry.favorite} aria-label={entry.favorite ? "取消收藏" : "收藏文章"} title={entry.favorite ? "取消收藏" : "收藏文章"} disabled={favoriteUpdating} onClick={() => void toggleFavorite()}>{entry.favorite ? "★" : "☆"}</button>
        <button type="button" className="toolbar-icon-button ai-toggle" aria-pressed={assistantVisible} aria-label={assistantVisible ? "最小化 AI 学习" : "打开 AI 学习"} title={assistantVisible ? "最小化 AI 学习" : "打开 AI 学习"} disabled={!article} onClick={toggleAssistant}>✦</button>
        <button type="button" className="toolbar-icon-button reader-focus-toggle" aria-pressed={readerOnly} aria-label={readerOnly ? "退出沉浸阅读" : "仅保留阅读栏"} title={readerOnly ? "退出沉浸阅读" : "仅保留阅读栏"} onClick={onToggleReaderOnly}>⛶</button>
        <button type="button" className="toolbar-icon-button external-button" aria-label="在浏览器中打开原文" title="在浏览器中打开原文" onClick={() => void window.reader.openExternal(entry.url)}>↗</button>
      </div>
    </header>
    <div ref={readerWorkspaceElement} className={`reader-workspace ${assistantVisible && article ? "reader-workspace--assistant" : ""}`}>
      <div className="reader-scroll" onScroll={textSelection ? clearTextSelection : undefined}>
        {loading && <div className="reader-loading" role="status"><span className="loading-mark" /><p>正在准备适合阅读的正文…</p></div>}
        {!loading && embedded && <div className="reader-embedded"><h1>{entry.title}</h1><p>该站点不允许自动提取正文，原文已在 Reading Hub 的受限窗口中打开。该窗口不使用外部浏览器，也不会复用登录态。</p><button type="button" className="primary-action" onClick={() => void loadArticle()}>重新打开原文</button></div>}
        {!loading && error && <div className="reader-failure"><h1>{entry.title}</h1><p>{error}</p><div><button type="button" className="primary-action" onClick={() => void loadArticle()}>重试</button><button type="button" onClick={openEmbedded}>在应用内打开原文</button></div></div>}
        {!loading && article && <article className="reader-article">
          <header><p className="eyebrow">{source?.title || "已保存内容"}</p><h1>{article.title}</h1>{(article.author || date) && <p className="reader-byline">{article.author}{article.author && date ? " · " : ""}{date}</p>}</header>
          {article.contentMode === "feed_summary" && <aside className="reader-content-notice" role="note">正在显示订阅 Feed 提供的内容摘要。该原页不允许自动读取；请使用右上角 ↗ 查看完整原文。</aside>}
          {article.coverImageUrl && <button type="button" className="reader-cover-button" onClick={(event) => {
            const image = event.currentTarget.querySelector("img");
            if (image) previewImage(image);
          }} aria-label="放大封面图片"><img className="reader-cover" src={article.coverImageUrl} alt="" onError={handleContentError} /></button>}
          <div ref={articleBodyElement} className="article-body" onClick={handleContentClick} onKeyDown={handleContentKeyDown} onKeyUp={captureArticleSelection} onMouseUp={captureArticleSelection} onError={handleContentError} dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
        </article>}
      </div>
      {textSelection && <div className="reader-selection-underlines" aria-hidden="true">{textSelection.overlay.underlines.map((underline, index) => <span key={`${underline.left}-${underline.top}-${index}`} style={{ left: underline.left, top: underline.top, width: underline.width }} />)}</div>}
      {textSelection && <section className="reader-selection-toolbar" role="toolbar" aria-label="所选文字操作" style={{ left: textSelection.overlay.toolbarLeft, top: textSelection.overlay.toolbarTop }}>
        {!textSelection.asking ? <>
          <button type="button" onClick={() => askAboutSelection("translate")}>翻译</button>
          <button type="button" onClick={() => askAboutSelection("explain")}>解释</button>
          <button type="button" onClick={revealSelectionQuestion}>提问</button>
          <button type="button" className="selection-cancel" onClick={clearTextSelection} aria-label="取消所选文字操作">×</button>
        </> : <form onSubmit={submitSelectionQuestion}>
          <input value={selectionQuestion} onChange={(event) => setSelectionQuestion(event.target.value)} placeholder="问所选文字…" maxLength={600} autoFocus />
          <button type="submit" disabled={!selectionQuestion.trim()}>发送</button>
          <button type="button" className="selection-cancel" onClick={clearTextSelection} aria-label="取消所选文字提问">×</button>
        </form>}
      </section>}
      {textSelection?.request && article && <SelectionAssistantCard
        request={textSelection.request}
        overlay={textSelection.overlay}
        article={article}
        sourceTitle={source?.title}
        preferredProviderId={preferredAiProviderId}
        onClose={clearTextSelection}
        onOpenSettings={() => { clearTextSelection(); onOpenSettings(); }}
      />}
      {assistantMounted && article && <ReaderAssistant
        article={article}
        sourceTitle={source?.title}
        providerId={preferredAiProviderId}
        onProviderChange={setPreferredAiProviderId}
        minimized={assistantState === "minimized"}
        onMinimize={() => setAssistantState("minimized")}
        onClose={() => setAssistantState("closed")}
        onOpenSettings={onOpenSettings}
      />}
      {assistantState === "minimized" && article && <button type="button" className="assistant-launcher" onClick={() => setAssistantState("open")} aria-label="恢复 AI 学习助手" title="恢复 AI 学习助手">✦</button>}
    </div>
    {imagePreview && <ImagePreview image={imagePreview} onClose={() => setImagePreview(undefined)} />}
  </section>;
}

function SelectionAssistantCard({ request, overlay, article, sourceTitle, preferredProviderId, onClose, onOpenSettings }: {
  request: AssistantSelectionRequest;
  overlay: SelectionOverlay;
  article: ReaderArticle;
  sourceTitle?: string;
  preferredProviderId: AiProviderId;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequestId = useRef<string>();
  const startedSelectionRequest = useRef<string>();
  const provider = useMemo(() => providers.find((item) => item.id === preferredProviderId && item.configured)
    || providers.find((item) => item.configured), [preferredProviderId, providers]);
  const cardStyle: CSSProperties = {
    left: overlay.cardLeft,
    top: overlay.cardTop,
    width: overlay.cardWidth,
    maxHeight: overlay.cardMaxHeight
  };

  useEffect(() => {
    let current = true;
    void window.reader.listAiProviders()
      .then((next) => { if (current) setProviders(next); })
      .catch((reason) => { if (current) setError(errorMessage(reason)); });
    return () => { current = false; };
  }, []);
  useEffect(() => window.reader.onAiStream((event) => {
    if (activeRequestId.current !== event.requestId) return;
    if (event.type === "delta") {
      setAnswer((current) => `${current}${event.text}`);
      return;
    }
    activeRequestId.current = undefined;
    setBusy(false);
    if (event.type === "complete") {
      setAnswer(event.answer.text);
      return;
    }
    setError(event.message);
  }), []);
  useEffect(() => {
    if (startedSelectionRequest.current === request.id || !providers.length) return;
    if (!provider) {
      startedSelectionRequest.current = request.id;
      setAnswer("");
      setBusy(false);
      setError("尚未配置可用的 AI 服务。请先在 AI 学习中完成设置。");
      return;
    }
    startedSelectionRequest.current = request.id;
    const requestId = newAiRequestId();
    activeRequestId.current = requestId;
    setAnswer("");
    setBusy(true);
    setError(undefined);
    void window.reader.startAiStream({
      requestId,
      request: {
        provider: provider.id,
        question: request.question,
        selection: request.selection,
        article: { title: article.title, url: article.url, sourceTitle, text: toArticleText(article.contentHtml) }
      }
    }).catch((reason) => {
      if (activeRequestId.current !== requestId) return;
      activeRequestId.current = undefined;
      setBusy(false);
      setError(errorMessage(reason));
    });
  }, [article.contentHtml, article.title, article.url, provider, providers.length, request, sourceTitle]);

  const excerpt = request.selection.text.length > 260 ? `${request.selection.text.slice(0, 260)}…` : request.selection.text;
  return <aside className="selection-assistant-card" data-placement={overlay.placement} data-intent={request.selection.intent} style={cardStyle} aria-label={`${selectedTextLabel(request.selection.intent)}结果`}>
    <header>
      <div><p>{selectedTextLabel(request.selection.intent)}</p><strong>{provider?.label || "AI 学习"}</strong></div>
      <button type="button" onClick={onClose} aria-label="关闭所选文字回答">×</button>
    </header>
    <blockquote>“{excerpt}”</blockquote>
    <div className="selection-assistant-answer" aria-live="polite" aria-busy={busy}>
      {busy && !answer && <p className="ai-streaming-status">正在结合文章上下文生成…</p>}
      {answer && <AiMarkdownContent text={answer} />}
      {error && <p className="selection-assistant-error">{error}</p>}
    </div>
    {error && !provider && <button type="button" className="selection-assistant-settings" onClick={onOpenSettings}>打开 AI 设置</button>}
  </aside>;
}

function ImagePreview({ image, onClose }: { image: ReaderImagePreview; onClose: () => void }) {
  return <div className="reader-image-lightbox" role="presentation" onClick={onClose}>
    <section className="reader-image-lightbox__frame" role="dialog" aria-modal="true" aria-label={image.alt} onClick={(event) => event.stopPropagation()}>
      <button type="button" className="reader-image-lightbox__close" onClick={onClose} autoFocus aria-label="关闭图片预览">×</button>
      <img src={image.src} alt={image.alt} />
    </section>
  </div>;
}

type AiMessage = { id: string; role: "user" | "assistant"; text: string; error?: boolean; streaming?: boolean };
type ActiveAiStream = { requestId: string; assistantMessageId: string };

const CODEX_EFFORT_OPTIONS: Array<{ value: AiReasoningEffort; label: string }> = [
  { value: "low", label: "低（更快）" },
  { value: "medium", label: "中（均衡）" },
  { value: "high", label: "高（更深入）" },
  { value: "xhigh", label: "极高（最慢）" },
  { value: "max", label: "最大（最难问题）" }
];

function ReaderAssistant({ article, sourceTitle, providerId: controlledProviderId, onProviderChange, minimized, onMinimize, onClose, onOpenSettings }: {
  article: ReaderArticle;
  sourceTitle?: string;
  providerId: AiProviderId;
  onProviderChange: (providerId: AiProviderId) => void;
  minimized: boolean;
  onMinimize: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId>(controlledProviderId);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeStream = useRef<ActiveAiStream>();
  const messagesElement = useRef<HTMLDivElement>(null);

  const selected = providers.find((provider) => provider.id === providerId);
  const reloadProviders = useCallback(async () => {
    const next = await window.reader.listAiProviders();
    setProviders(next);
    const active = next.find((provider) => provider.id === controlledProviderId) || next[0];
    if (active) {
      setProviderId(active.id);
      onProviderChange(active.id);
    }
  }, [controlledProviderId, onProviderChange]);
  useEffect(() => { void reloadProviders().catch((reason) => setError(errorMessage(reason))); }, [reloadProviders]);
  useEffect(() => {
    return window.reader.onAiStream((event) => {
      const active = activeStream.current;
      if (!active || active.requestId !== event.requestId) return;
      if (event.type === "delta") {
        setMessages((current) => current.map((message) => message.id === active.assistantMessageId
          ? { ...message, text: `${message.text}${event.text}` }
          : message));
        return;
      }
      activeStream.current = undefined;
      setBusy(false);
      if (event.type === "complete") {
        setMessages((current) => current.map((message) => message.id === active.assistantMessageId
          ? { ...message, text: event.answer.text, streaming: false }
          : message));
        return;
      }
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, text: message.text ? `${message.text}\n\n生成中断：${event.message}` : event.message, error: true, streaming: false }
        : message));
    });
  }, []);
  useEffect(() => {
    const element = messagesElement.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  function switchProvider(nextId: AiProviderId) {
    setProviderId(nextId);
    onProviderChange(nextId);
    setError(undefined);
  }

  async function startQuestion(textValue: string, selection?: AiSelectionContext) {
    const text = textValue.trim();
    if (!text || busy) return;
    if (!selected?.configured) {
      setError(selected?.requiresApiKey ? "请先在设置中配置 API Key。" : "未检测到本机 Codex CLI。请安装并登录后重试。");
      onOpenSettings();
      return;
    }
    const prompt = toArticleText(article.contentHtml);
    setQuestion(""); setBusy(true); setError(undefined);
    const requestId = newAiRequestId();
    const assistantMessageId = newAiRequestId();
    activeStream.current = { requestId, assistantMessageId };
    const displayText = selection
      ? `${selectedTextLabel(selection.intent)}\n\n“${selection.text}”\n\n${text}`
      : text;
    setMessages((current) => [...current, { id: newAiRequestId(), role: "user", text: displayText }, { id: assistantMessageId, role: "assistant", text: "", streaming: true }]);
    try {
      await window.reader.startAiStream({
        requestId,
        request: {
          provider: providerId,
          question: text,
          selection,
          article: { title: article.title, url: article.url, sourceTitle, text: prompt }
        }
      });
    } catch (reason) {
      const message = errorMessage(reason);
      if (activeStream.current?.requestId !== requestId) return;
      activeStream.current = undefined;
      setBusy(false);
      setMessages((current) => current.map((item) => item.id === assistantMessageId ? { ...item, text: message, error: true, streaming: false } : item));
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    await startQuestion(question);
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitAssistantQuestion(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return <aside className={`reader-ai-panel${minimized ? " is-minimized" : ""}`} aria-label="AI 学习助手" aria-hidden={minimized}>
    <header><div><strong>AI 学习助手</strong><p>提问时才会发送当前文章的文本摘录。</p></div><div className="assistant-header-actions"><button type="button" className="panel-icon-button" onClick={onMinimize} aria-label="最小化 AI 学习助手" title="最小化">−</button><button type="button" className="panel-icon-button" onClick={onClose} aria-label="关闭 AI 学习助手" title="关闭">×</button></div></header>
    <div className="ai-provider-row"><label htmlFor="ai-provider">服务</label><select id="ai-provider" value={providerId} onChange={(event) => switchProvider(event.target.value as AiProviderId)} disabled={busy}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select><button type="button" onClick={onOpenSettings} disabled={busy}>设置</button></div>
    {selected?.availabilityMessage && <p className="ai-provider-note">{selected.availabilityMessage}</p>}
    {error && <p className="error ai-error">{error}</p>}
    <div className="ai-messages" aria-live="polite" aria-busy={busy} ref={messagesElement}>{!messages.length && <p className="ai-empty">可以让 AI 解释概念、公式推导、例子或文章中的论证。回答不会保存到数据库。</p>}{messages.map((message) => <div key={message.id} className={`ai-message ${message.role}${message.error ? " error" : ""}${message.streaming ? " is-streaming" : ""}`}><strong>{message.role === "user" ? "你" : selected?.label || "AI"}</strong>{message.streaming && !message.text ? <p className="ai-streaming-status">正在生成…</p> : <AiMarkdownContent text={message.text} />}</div>)}</div>
    <form className="ai-question" onSubmit={(event) => void ask(event)}><label htmlFor="ai-question">向文章提问（Enter 发送，Shift+Enter 换行）</label><textarea id="ai-question" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={submitOnEnter} placeholder="例如：请用直觉解释这个公式的含义" disabled={busy} /><button className="primary" disabled={busy || !question.trim()}>{busy ? "回答中…" : "发送问题"}</button></form>
  </aside>;
}

type SettingsSection = "reading" | "ai";

/** Global preferences live in a dedicated view so the article surface stays for reading. */
function SettingsView({ onClose, windowFullscreen }: { onClose: () => void; windowFullscreen: boolean }) {
  const [section, setSection] = useState<SettingsSection>("reading");
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadReaderPreferences);
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId>("codex-cli");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<AiReasoningEffort>("medium");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    window.localStorage.setItem(READER_PREFERENCES_KEY, JSON.stringify(preferences));
  }, [preferences]);

  const reloadProviders = useCallback(async () => {
    const next = await window.reader.listAiProviders();
    setProviders(next);
    const active = next.find((provider) => provider.id === providerId) || next[0];
    if (!active) return;
    setProviderId(active.id);
    setModel(active.model);
    setEffort(active.effort || "medium");
  }, [providerId]);

  useEffect(() => { void reloadProviders().catch((reason) => setError(errorMessage(reason))); }, [reloadProviders]);

  const selected = providers.find((provider) => provider.id === providerId);
  const usingCodexCli = selected?.id === "codex-cli";
  const requiresApiKey = selected?.requiresApiKey === true;

  function switchProvider(nextId: AiProviderId) {
    const next = providers.find((provider) => provider.id === nextId);
    setProviderId(nextId);
    setModel(next?.model || "");
    setEffort(next?.effort || "medium");
    setApiKey("");
    setError(undefined);
  }

  async function saveAiSettings(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(undefined);
    try {
      await window.reader.configureAiProvider({
        provider: providerId,
        apiKey,
        model,
        effort: usingCodexCli ? effort : undefined
      });
      setApiKey("");
      await reloadProviders();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function clearAiSettings() {
    if (!selected) return;
    const message = usingCodexCli
      ? "恢复本机 Codex CLI 的默认模型与推理强度？"
      : `清除 ${selected.label} 的 API Key？`;
    if (!window.confirm(message)) return;
    setBusy(true); setError(undefined);
    try {
      await window.reader.clearAiProvider(providerId);
      setApiKey("");
      await reloadProviders();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const adjustFont = (amount: number) => setPreferences((current) => ({
    ...current,
    fontScale: Math.min(1.25, Math.max(0.85, Number((current.fontScale + amount).toFixed(2))))
  }));

  return <main className={`settings-shell${windowFullscreen ? " settings-shell--fullscreen" : ""}`} aria-label="Reading Hub 设置">
    <header className="app-titlebar settings-titlebar">
      <div className="app-titlebar-actions"><button type="button" className="app-titlebar-button" onClick={onClose} aria-label="返回阅读器" title="返回阅读器"><AppIcon name="back" /></button></div>
      <p>设置</p>
    </header>
    <aside className="settings-sidebar" aria-label="设置分类">
      <p className="settings-sidebar-title">设置</p>
      <nav>
        <button type="button" className={section === "reading" ? "selected" : ""} onClick={() => setSection("reading")} aria-current={section === "reading" ? "page" : undefined}><AppIcon name="reading" /><span>阅读体验</span></button>
        <button type="button" className={section === "ai" ? "selected" : ""} onClick={() => setSection("ai")} aria-current={section === "ai" ? "page" : undefined}><AppIcon name="ai" /><span>AI 功能</span></button>
      </nav>
      <p className="settings-sidebar-note">偏好仅保存在此设备。</p>
    </aside>
    <section className="settings-content">
      {section === "reading" ? <>
        <header><p className="eyebrow">阅读</p><h1>阅读体验</h1><p>控制正文的密度与字号，不改变原文内容。</p></header>
        <section className="settings-card">
          <h2>正文排版</h2>
          <div className="settings-row"><div><strong>阅读密度</strong><span>阅读模式保留更舒适的行距；紧凑模式用于快速浏览。</span></div><div className="settings-segmented" role="group" aria-label="阅读密度"><button type="button" className={preferences.preset === "compact" ? "selected" : ""} onClick={() => setPreferences((current) => ({ ...current, preset: "compact" }))}>紧凑</button><button type="button" className={preferences.preset === "reading" ? "selected" : ""} onClick={() => setPreferences((current) => ({ ...current, preset: "reading" }))}>阅读</button></div></div>
          <div className="settings-row"><div><strong>正文字号</strong><span>当前 {Math.round(preferences.fontScale * 100)}%</span></div><div className="settings-font-controls"><button type="button" onClick={() => adjustFont(-0.05)} disabled={preferences.fontScale <= 0.85}>A−</button><output>{Math.round(preferences.fontScale * 100)}%</output><button type="button" onClick={() => adjustFont(0.05)} disabled={preferences.fontScale >= 1.25}>A+</button></div></div>
        </section>
        <section className="settings-card settings-card--quiet"><h2>沉浸阅读</h2><p>打开任意文章后，使用阅读栏右上角的 ⛶ 可隐藏来源与文章列表，只保留正文阅读栏。</p></section>
      </> : <>
        <header><p className="eyebrow">AI 功能</p><h1>服务与连接</h1><p>密钥仅写入 macOS Keychain，不保存在数据库或页面中。</p></header>
        <form className="settings-card settings-ai-form" onSubmit={(event) => void saveAiSettings(event)}>
          <h2>AI 服务</h2>
          <label>服务<select value={providerId} onChange={(event) => switchProvider(event.target.value as AiProviderId)} disabled={busy}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
          {usingCodexCli ? <>
            <label>模型<select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>{CODEX_CLI_MODEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label>推理强度<select value={effort} onChange={(event) => setEffort(event.target.value as AiReasoningEffort)} disabled={busy}>{CODEX_EFFORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <p className="settings-help">模型可用性取决于 Codex/ChatGPT 账户；较高推理强度会延长回答时间。</p>
          </> : <>
            <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder={selected?.model || "模型名称"} required disabled={busy} /></label>
            <label>API Key<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder={selected?.configured ? "留空则保留现有密钥" : "仅保存到 macOS Keychain"} required={requiresApiKey && !selected?.configured} disabled={busy} /></label>
          </>}
          {selected?.availabilityMessage && <p className="settings-help">{selected.availabilityMessage}</p>}
          {error && <p className="error">{error}</p>}
          <div className="settings-actions"><button type="submit" className="primary" disabled={!selected || busy}>{busy ? "正在保存…" : "保存设置"}</button>{selected?.configured && <button type="button" className="danger" onClick={() => void clearAiSettings()} disabled={busy}>{usingCodexCli ? "恢复默认" : "清除密钥"}</button>}</div>
        </form>
      </>}
    </section>
  </main>;
}

function toArticleText(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  return (document.body.textContent || "").replace(/\s+/g, " ").trim();
}

function PreviewDialog({ pending, onCancel, onConfirm, busy }: { pending: PendingPreview; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const { probe } = pending;
  return <Dialog title="确认来源" onClose={onCancel}>
    <p className="dialog-intro"><strong>{probe.title}</strong><br />{probe.kind === "rss" ? "已发现 Feed，将自动更新。" : probe.kind === "manual" ? "小红书分享链接将作为一次性卡片保存。" : probe.requiresReview ? "结构识别置信度较低，保存后需要校正规则。" : "已识别公开页面结构，将自动更新。"}</p>
    <div className="preview-list">{probe.preview.slice(0, 4).map((entry) => <div key={entry.url}><strong>{entry.title}</strong><span>{entry.summary}</span></div>)}</div>
    <div className="dialog-actions"><button onClick={onCancel}>取消</button><button className="primary" onClick={onConfirm} disabled={busy}>保存来源</button></div>
  </Dialog>;
}

function AddSourceDialog({ onClose, onPreview, onImportOpml, onZhihuStarted, onXStarted, onXiaohongshuSaved, onAcademicSaved }: {
  onClose: () => void;
  onPreview: (url: string) => Promise<void>;
  onImportOpml: () => Promise<OpmlImportResult>;
  onZhihuStarted: () => Promise<void>;
  onXStarted: () => Promise<void>;
  onXiaohongshuSaved: () => Promise<void>;
  onAcademicSaved: () => Promise<void>;
}) {
  const [method, setMethod] = useState<AddSourceMethod>("public");
  const methods: Array<{ id: AddSourceMethod; label: string; description: string }> = [
    { id: "public", label: "网页 / Feed", description: "RSS、公开文章列表页或分享链接" },
    { id: "zhihu", label: "知乎动态", description: "授权账号的关注页公开动态" },
    { id: "x", label: "X 动态", description: "官方 API 授权后的关注动态" },
    { id: "xiaohongshu", label: "小红书", description: "公开博主主页中的结构化笔记卡片" },
    { id: "academic", label: "学术作者", description: "公开学术索引中的新论文" }
  ];
  const selected = methods.find((item) => item.id === method)!;
  return <Dialog title="添加来源" onClose={onClose}>
    <div className="source-method-tabs" role="tablist" aria-label="来源类型">
      {methods.map((item) => <button key={item.id} type="button" role="tab" aria-selected={method === item.id} className={method === item.id ? "selected" : ""} onClick={() => setMethod(item.id)}>{item.label}</button>)}
    </div>
    <p className="source-method-description">{selected.description}</p>
    {method === "public" && <PublicSourcePane onPreview={onPreview} onImportOpml={onImportOpml} />}
    {method === "zhihu" && <ZhihuSourcePane onStarted={onZhihuStarted} />}
    {method === "x" && <XSourcePane onStarted={onXStarted} />}
    {method === "xiaohongshu" && <XiaohongshuSourcePane onSaved={onXiaohongshuSaved} />}
    {method === "academic" && <AcademicSourcePane onSaved={onAcademicSaved} />}
  </Dialog>;
}

function PublicSourcePane({ onPreview, onImportOpml }: { onPreview: (url: string) => Promise<void>; onImportOpml: () => Promise<OpmlImportResult> }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [imported, setImported] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true); setError(undefined);
    try { await onPreview(url.trim()); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function importFile() {
    setBusy(true); setError(undefined); setImported(undefined);
    try {
      const result = await onImportOpml();
      if (!result.cancelled) setImported(`已导入 ${result.imported} 个 Feed${result.existing ? `；${result.existing} 个已存在` : ""}${result.skipped ? `；跳过 ${result.skipped} 个` : ""}。`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return <form className="connector-form" onSubmit={(event) => void submit(event)}>
    <label htmlFor="source-url">网址</label>
    <input id="source-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://… 或 http://…" type="url" required />
    <p className="dialog-intro">优先识别 RSS、Atom、JSON Feed；没有 Feed 时会从公开页面提取文章卡片。也可导入 OPML。明确添加的本机地址仅接受 RSS/Atom/JSON Feed，不能用于网页提取。X 主页请在“X 动态”中使用官方 API。</p>
    {error && <p className="error">{error}</p>}
    {imported && <p className="source-settings-note">{imported}</p>}
    <div className="dialog-actions"><button type="button" onClick={() => void importFile()} disabled={busy}>导入 OPML…</button><button className="primary" disabled={busy}>{busy ? "正在探测…" : "探测来源"}</button></div>
  </form>;
}

function ZhihuSourcePane({ onStarted }: { onStarted: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(undefined);
    try { await window.reader.connectZhihuFollow(); await onStarted(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <section className="source-method-pane">
    <p className="dialog-intro">将打开 Reading Hub 自己的知乎登录窗口。登录后会读取“关注”动态中的公开卡片，包括关注用户的创作及其公开互动；不会读取或复制 Chrome 的 Cookie。</p>
    <p className="dialog-intro">登录会话仅保存于本机。删除该来源会同时退出并清除该会话。</p>
    <p className="dialog-intro">已有的“知乎（本人官方数据）”来源不会自动改写；不再需要时可在左侧单独删除。</p>
    {error && <p className="error">{error}</p>}
    <div className="dialog-actions"><button type="button" className="primary" onClick={() => void submit()} disabled={busy}>打开知乎登录</button></div>
  </section>;
}

function XSourcePane({ onStarted }: { onStarted: () => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { await window.reader.connectX(clientId); await onStarted(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <section className="source-method-pane">
    <p className="dialog-intro">X 当前未提供可由 Reading Hub 在免 API 模式下自动读取的公开博主时间线，因此“公开博主”订阅已下线。应用不会使用 Cookie、登录态或私有 Web API 绕过此限制。</p>
    <p className="dialog-intro">此功能使用官方 X API，不读取浏览器 Cookie。请在 X Developer Console 为你的应用配置回调地址 <code>http://127.0.0.1:43119/x/callback</code>，并填写该应用的 Client ID。</p>
    <p className="dialog-intro">授权后默认每 30–60 分钟收集关注账号的原创帖和文章型外链，过滤回复与转推。访问令牌仅保存在本机 Keychain；X 当前的 API 额度和计费资格由你的开发者项目决定。</p>
    <form className="connector-form" onSubmit={(event) => void submit(event)}><label htmlFor="x-client-id">X Client ID</label><input id="x-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Developer App Client ID" autoComplete="off" required />{error && <p className="error">{error}</p>}<div className="dialog-actions"><button className="primary" disabled={busy}>{busy ? "等待授权…" : "在浏览器中授权 X"}</button></div></form>
  </section>;
}

function XiaohongshuSourcePane({ onSaved }: { onSaved: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true); setError(undefined);
    try {
      await window.reader.subscribeXiaohongshuProfile({ url: url.trim(), title: title.trim() || undefined });
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return <section className="source-method-pane profile-source-pane">
    <p className="dialog-intro">输入小红书公开博主主页，例如 <code>https://www.xiaohongshu.com/user/profile/用户ID</code>。Reading Hub 直接读取 robots 允许的公开页面中已有的结构化笔记卡片，不需要本地或远程 RSSHub。</p>
    <p className="dialog-intro">如果页面要求登录、Cookie、验证码或没有公开笔记结构，应用会停止并说明原因；不会绕过访问限制。单篇内容仍可在“网页 / Feed”中粘贴分享链接保存。</p>
    <form className="connector-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="xiaohongshu-profile-url">小红书博主主页</label>
      <input id="xiaohongshu-profile-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.xiaohongshu.com/user/profile/用户ID" type="url" required />
      <label htmlFor="xiaohongshu-profile-title">显示名称（可选）</label>
      <input id="xiaohongshu-profile-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="小红书 · 某位博主" maxLength={120} />
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions"><button className="primary" disabled={busy}>{busy ? "正在读取公开主页…" : "添加小红书博主"}</button></div>
    </form>
  </section>;
}

function AcademicSourcePane({ onSaved }: { onSaved: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SubscriptionDraft[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true); setError(undefined);
    try { setResults(await window.reader.searchAcademicAuthors(query.trim())); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function choose(draft: SubscriptionDraft) {
    setBusy(true); setError(undefined);
    try { await window.reader.subscribeAcademicAuthor(draft); await onSaved(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <section className="source-method-pane">
    <p className="dialog-intro">从 OpenAlex、Semantic Scholar 与可公开读取的 ORCID works 中聚合论文；卡片会保留实际来源。它不是 Google Scholar 页面同步，也不读取 Scholar 登录态或邮件。</p>
    <form className="connector-form" onSubmit={(event) => void search(event)}><label htmlFor="academic-query">作者姓名</label><div className="connector-search"><input id="academic-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如 Geoffrey Hinton" /><button className="primary" disabled={busy}>搜索</button></div></form>
    {results.length > 0 && <div className="academic-results">{results.map((draft, index) => <button type="button" key={`${draft.targetId}-${index}`} onClick={() => void choose(draft)} disabled={busy}><strong>{draft.title}</strong><span>{draft.config?.orcid ? `ORCID ${String(draft.config.orcid)}` : "确认此作者"}</span></button>)}</div>}
    {error && <p className="error">{error}</p>}
  </section>;
}

function CalibrationDialog({ source, onClose, onSaved }: { source: Source; onClose: () => void; onSaved: () => Promise<void> }) {
  const [result, setResult] = useState<CalibrationResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const detect = useCallback(async () => {
    setBusy(true); setError(undefined);
    try { setResult(await window.reader.calibrateSource(source.id)); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }, [source.id]);
  useEffect(() => { void detect(); }, [detect]);
  async function apply(candidate: CalibrationResult["candidates"][number]) {
    setBusy(true); setError(undefined);
    try {
      await window.reader.updateRule(source.id, candidate.rule);
      await window.reader.refreshSource(source.id);
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog title={`自动校准「${source.title}」`} onClose={onClose}>
    <p className="dialog-intro">无需了解 CSS。请从下方候选中选择一组看起来像该网站文章列表的卡片；应用会保存规则、移除之前误识别的卡片，并立即验证。</p>
    {busy && !result && <p className="dialog-intro">正在分析网页结构…</p>}
    {result?.candidates.map((candidate, index) => <section className="calibration-candidate" key={`${candidate.label}-${index}`}><div><strong>{candidate.label}</strong><span>识别置信度 {Math.round(candidate.confidence * 100)}%</span></div><div className="preview-list">{candidate.preview.slice(0, 2).map((entry) => <div key={entry.url}><strong>{entry.title}</strong><span>{entry.summary || entry.url}</span></div>)}</div><button className="primary" onClick={() => void apply(candidate)} disabled={busy}>这组内容是正确的</button></section>)}
    {result && !result.candidates.length && <p className="dialog-intro">{result.message}</p>}
    {error && <p className="error">{error}</p>}
    <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="button" onClick={() => void detect()} disabled={busy}>重新自动检测</button></div>
  </Dialog>;
}

const PUBLIC_SOURCE_KINDS: SourceKind[] = ["rss", "generic", "manual"];
const REFRESH_OPTIONS: Array<{ value: "default" | "30" | "60" | "120" | "240" | "720" | "1440"; label: string }> = [
  { value: "default", label: "自动（30–60 分钟）" },
  { value: "30", label: "约 30 分钟" },
  { value: "60", label: "约 1 小时" },
  { value: "120", label: "约 2 小时" },
  { value: "240", label: "约 4 小时" },
  { value: "720", label: "约 12 小时" },
  { value: "1440", label: "约每天一次" }
];

function isRetiredXPublicProfile(source: Source | undefined): boolean {
  return source?.kind === "x" && source.connectorId === "x" && source.config?.mode === "public-profile";
}

function SourceSettingsDialog({ source, onClose, onSaved, onRefresh, onCalibrate, onDelete, onReconnectZhihu }: {
  source: Source;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onCalibrate: () => void;
  onDelete: () => Promise<void>;
  onReconnectZhihu: () => Promise<void>;
}) {
  const [title, setTitle] = useState(source.title);
  const [category, setCategory] = useState(source.category || "");
  const [kind, setKind] = useState<SourceKind>(source.kind);
  const [pollingEnabled, setPollingEnabled] = useState(source.pollingEnabled);
  const [refresh, setRefresh] = useState<"default" | "30" | "60" | "120" | "240" | "720" | "1440">(source.refreshIntervalMinutes ? String(source.refreshIntervalMinutes) as "30" | "60" | "120" | "240" | "720" | "1440" : "default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const legacyRssHubFeed = source.config?.sourceProvider === "rsshub";
  const retiredXPublicProfile = isRetiredXPublicProfile(source);
  const typeLocked = !PUBLIC_SOURCE_KINDS.includes(source.kind) || legacyRssHubFeed;
  const manual = kind === "manual";

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await window.reader.updateSourceSettings(source.id, {
        title,
        category,
        kind,
        pollingEnabled: manual ? false : pollingEnabled,
        refreshIntervalMinutes: !manual && pollingEnabled && refresh !== "default" ? Number(refresh) : undefined
      });
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runOperation(operation: () => void | Promise<void>) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={`配置「${source.title}」`} onClose={onClose}>
    <form className="source-settings-form" onSubmit={(event) => void save(event)}>
      <label>来源名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required autoFocus /></label>
      <label>分类<input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={60} placeholder="留空则自动归类" /></label>
      <p className="source-settings-note">分类仅保存在本机，用于将来源整理为可折叠的文件夹。</p>
      <label>信源类型<select value={kind} onChange={(event) => setKind(event.target.value as SourceKind)} disabled={typeLocked || busy}>
        {typeLocked ? <option value={source.kind}>{sourceKindLabel(source.kind)}</option> : PUBLIC_SOURCE_KINDS.map((item) => <option key={item} value={item}>{sourceKindLabel(item)}</option>)}
      </select></label>
      {typeLocked && <p className="source-settings-note">{retiredXPublicProfile ? "此旧 X 公开来源已停止刷新：X 没有提供可合规自动读取的公开订阅接口。已有卡片会保留；如需继续同步，请删除它后使用官方 API。" : legacyRssHubFeed ? "已保存的 RSSHub Feed 仍使用 RSS 连接器；这里可调整名称和刷新频率。" : "平台来源的类型及账号绑定由内置连接器管理；这里仍可调整名称和刷新频率。"}</p>}
      <label className="source-settings-toggle"><input type="checkbox" checked={!manual && pollingEnabled} onChange={(event) => setPollingEnabled(event.target.checked)} disabled={manual || retiredXPublicProfile || busy} />自动刷新</label>
      <label>刷新时间<select value={refresh} onChange={(event) => setRefresh(event.target.value as typeof refresh)} disabled={manual || retiredXPublicProfile || !pollingEnabled || busy}>{REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {manual && <p className="source-settings-note">分享链接是一次性阅读卡片，不会自动轮询。</p>}
      <label>来源地址<input value={source.url} readOnly aria-readonly="true" /></label>
      <dl className="source-settings-details"><div><dt>当前状态</dt><dd><StatusBadge status={source.status} /></dd></div><div><dt>实际连接器</dt><dd>{sourceConnectorLabel(source)}</dd></div></dl>
      <div className="source-settings-operations">{!retiredXPublicProfile && <button type="button" onClick={() => void runOperation(onRefresh)} disabled={busy}>立即刷新</button>}{source.kind === "generic" && <button type="button" onClick={() => void runOperation(onCalibrate)} disabled={busy}>自动校准</button>}{source.kind === "zhihu_follow" && <button type="button" onClick={() => void runOperation(onReconnectZhihu)} disabled={busy}>重新登录知乎</button>}<button type="button" className="danger" onClick={() => void runOperation(onDelete)} disabled={busy}>删除来源</button></div>
      {error && <p className="error">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存配置"}</button></div>
    </form>
  </Dialog>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>;
}

function StatusBadge({ status }: { status: Source["status"] }) {
  const labels = { active: "正常", needs_review: "需校正", paused: "已暂停", error: "重试中" };
  return <span className={`status ${status}`}>{labels[status]}</span>;
}

function sourceKindLabel(kind: SourceKind): string {
  return { rss: "RSS / Atom / JSON Feed", generic: "公开网页", manual: "分享链接", zhihu: "知乎官方数据", zhihu_follow: "知乎关注动态", x: "X 关注动态", xiaohongshu: "小红书公开博主", academic: "学术作者更新" }[kind];
}

function sourceConnectorLabel(source: Source): string {
  return sourceKindLabel(source.connectorId || source.kind);
}

function sourceIconKind(source: Source): AppIconName {
  if (source.config?.sourceProvider === "rsshub") return source.config.rsshubPlatform === "xiaohongshu" ? "xiaohongshu" : "x";
  return {
    rss: "rss",
    generic: "web",
    manual: "link",
    zhihu: "zhihu",
    zhihu_follow: "zhihu-follow",
    x: "x",
    xiaohongshu: "xiaohongshu",
    academic: "academic"
  }[source.kind];
}

function SourceIcon({ source }: { source: Source }) {
  return <span className={`source-icon source-icon--${sourceIconKind(source)}`} aria-hidden="true"><AppIcon name={sourceIconKind(source)} /></span>;
}

type AppIconName = "sidebar" | "expand" | "refresh" | "add" | "today" | "unread" | "favorite" | "folder" | "chevron-down" | "chevron-right" | "settings" | "back" | "reading" | "ai" | "rss" | "web" | "link" | "zhihu" | "zhihu-follow" | "x" | "xiaohongshu" | "academic";

/** Compact, local-only line icons with a native macOS reading-list emphasis. */
function AppIcon({ name }: { name: AppIconName }) {
  const props = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "sidebar": return <svg {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9 4v16M12.5 9h4M12.5 13h4M12.5 17h2.5" /></svg>;
    case "expand": return <svg {...props}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>;
    case "refresh": return <svg {...props}><path d="M21 12a9 9 0 0 0-15.5-6.2L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16" /><path d="M21 21v-5h-5" /></svg>;
    case "add": return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case "today": return <svg {...props}><rect x="4" y="5.5" width="16" height="14" rx="2.5" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /><circle cx="12" cy="14.5" r="1.2" fill="currentColor" stroke="none" /></svg>;
    case "unread": return <svg {...props}><circle cx="12" cy="12" r="7" /></svg>;
    case "favorite": return <svg {...props}><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.8-5.4 2.8 1-6.1-4.4-4.3 6.1-.9Z" /></svg>;
    case "folder": return <svg {...props}><path d="M3.5 7.5h6l1.7 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /><path d="M3.5 7.5v-1a2 2 0 0 1 2-2H10l1.7 2" /></svg>;
    case "chevron-down": return <svg {...props}><path d="m7 9 5 5 5-5" /></svg>;
    case "chevron-right": return <svg {...props}><path d="m9 7 5 5-5 5" /></svg>;
    case "settings": return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19 12a7.7 7.7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.4 3.1h5l.4-3.1a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z" /></svg>;
    case "back": return <svg {...props}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
    case "reading": return <svg {...props}><path d="M5 4.5h10a4 4 0 0 1 4 4V20H9a4 4 0 0 0-4 1Z" /><path d="M5 4.5V21M9 8h6M9 12h6" /></svg>;
    case "ai": return <svg {...props}><path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z" /></svg>;
    case "rss": return <svg {...props}><circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" /><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" /></svg>;
    case "web": return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.2 2.2 3.2 4.9 3.2 8S14.2 17.8 12 20c-2.2-2.2-3.2-4.9-3.2-8S9.8 6.2 12 4Z" /></svg>;
    case "link": return <svg {...props}><path d="M10 14 14 10M8.2 17.8l-1.4 1.4a3 3 0 0 1-4.2-4.2L7 10.6a3 3 0 0 1 4.2 0M15.8 6.2l1.4-1.4a3 3 0 0 1 4.2 4.2L17 13.4a3 3 0 0 1-4.2 0" /></svg>;
    case "zhihu": return <svg {...props}><path d="M5 5.5h14v10H9l-4 3Z" /><path d="M8 9h8M8 12h5" /></svg>;
    case "zhihu-follow": return <svg {...props}><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.6-3 2.4-4.6 5.5-4.6S13.9 16 14.5 19M17 9v6M14 12h6" /></svg>;
    case "x": return <svg {...props}><path d="m5 4 14 16M19 4 5 20" /></svg>;
    case "xiaohongshu": return <svg {...props}><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 10h8M8 14h5" /><circle cx="17" cy="14" r="1" fill="currentColor" stroke="none" /></svg>;
    case "academic": return <svg {...props}><path d="m4 8 8-4 8 4-8 4Z" /><path d="M7 11v4.5c2.8 2 7.2 2 10 0V11M20 9v5" /></svg>;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请稍后重试。"; }
