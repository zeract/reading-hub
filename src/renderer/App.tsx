import { type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CODEX_CLI_MODEL_OPTIONS, type AiProviderId, type AiProviderSettings, type AiReasoningEffort, type CalibrationResult, type Entry, type Followee, type ProbeResult, type ReaderArticle, type Source, type SourceKind, type SubscriptionDraft } from "../shared/types";
import { AiMarkdownContent } from "./ai-markdown";
import { shouldSubmitAssistantQuestion } from "./assistant-input";
import { requiresSourceReload } from "./source-selection";
import { DEFAULT_TIMELINE_FILTER, defaultCustomTimelineDates, resolveTimelineRange, timelineQuery, type TimelineRangeFilter, type TimelineRangePreset } from "./timeline-filter";

type PendingPreview = { token: string; probe: ProbeResult };
type ReaderPreset = "reading" | "compact";
type ReaderPreferences = { preset: ReaderPreset; fontScale: number };
type AddSourceMethod = "public" | "zhihu" | "x" | "academic";
type AssistantPanelState = "closed" | "minimized" | "open";
type ReaderImagePreview = { src: string; alt: string };

const READER_PREFERENCES_KEY = "reading-hub.reader-preferences.v1";
const DEFAULT_READER_PREFERENCES: ReaderPreferences = { preset: "reading", fontScale: 1 };

function newAiRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // This id only pairs same-renderer IPC events; it is never an auth token.
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
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
  const [followees, setFollowees] = useState<Followee[]>([]);
  const [pending, setPending] = useState<PendingPreview>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [activeRuleSource, setActiveRuleSource] = useState<Source>();
  const [editingSource, setEditingSource] = useState<Source>();
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [timelineFilter, setTimelineFilter] = useState<TimelineRangeFilter>(DEFAULT_TIMELINE_FILTER);
  const [readingEntry, setReadingEntry] = useState<Entry>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const reloadSequence = useRef(0);

  const timelineRange = useMemo(() => resolveTimelineRange(timelineFilter), [timelineFilter]);
  const entriesQuery = useMemo(() => timelineQuery(activeSourceId, timelineRange), [activeSourceId, timelineRange]);

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
    const [nextSources, nextEntries, nextFollowees] = await Promise.all([
      window.reader.listSources(),
      timelineRange.invalid ? Promise.resolve([]) : window.reader.listEntries(entriesQuery),
      window.reader.listFollowees()
    ]);
    // A source or time-range change may have started a newer request while an
    // older IPC call was still in flight. Never replace the newest result.
    if (sequence !== reloadSequence.current) return;
    setSources(nextSources);
    setEntries(nextEntries);
    setFollowees(nextFollowees);
  }, [entriesQuery, timelineRange.invalid]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

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

  async function updateEntry(entry: Entry, field: "read" | "favorite", value: boolean) {
    if (field === "read") await window.reader.markRead(entry.id, value);
    else await window.reader.markFavorite(entry.id, value);
    await reload();
  }

  function openReader(entry: Entry) {
    setReadingEntry(entry);
    if (!entry.read) void updateEntry(entry, "read", true);
  }

  function selectSource(sourceId?: string) {
    setReadingEntry(undefined);
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

  function chooseTimelinePreset(preset: TimelineRangePreset) {
    setTimelineFilter((current) => {
      if (preset !== "custom" || current.startDate || current.endDate) return { ...current, preset };
      return { preset, ...defaultCustomTimelineDates() };
    });
  }

  async function deleteSource(source: Source) {
    if (!window.confirm(`删除「${source.title}」及其已收集内容？此操作无法撤销。`)) return;
    setBusy(true);
    try {
      await window.reader.deleteSource(source.id);
      if (activeSourceId === source.id) setActiveSourceId(undefined);
      if (readingEntry?.sourceId === source.id) setReadingEntry(undefined);
      setNotice(`已删除「${source.title}」。`);
      await reload();
    } catch (error) {
      setNotice(errorMessage(error));
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

  return (
    <main className={`shell${sidebarCollapsed ? " shell--sidebar-collapsed" : ""}${windowFullscreen ? " shell--fullscreen" : ""}`}>
      <header className="app-titlebar">
        <span className="app-titlebar-mark" aria-label="Reading Hub">R</span>
        <div className="app-titlebar-actions">
          <button type="button" className="app-titlebar-button" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? "显示来源边栏" : "隐藏来源边栏"} title={sidebarCollapsed ? "显示来源边栏" : "隐藏来源边栏"}>☰</button>
          {readingEntry && <button type="button" className="app-titlebar-button" onClick={() => setReadingEntry(undefined)} aria-label="返回列表" title="返回列表">←</button>}
        </div>
      </header>
      <aside className="sidebar">
        <button type="button" className="add-source-button" onClick={() => setShowAddSource(true)}>＋ 添加来源<span>网页、平台动态或学术作者</span></button>
        <div className="section-title">来源 <span>{sources.length}</span></div>
        <div className="source-list">
          <button className={`source-filter ${!activeSourceId ? "selected" : ""}`} onClick={() => selectSource(undefined)}>
            <span className="source-title">全部内容</span><span className="source-meta">按最新时间</span>
          </button>
          {sources.map((source) => (
            <div className="source-row" key={source.id} onContextMenu={(event) => { event.preventDefault(); setEditingSource(source); }}>
              <button className={`source-filter ${activeSourceId === source.id ? "selected" : ""}`} onClick={() => selectSource(source.id)}>
                <span className="source-title">{source.title}</span>
                <span className="source-meta"><span className="source-meta-line"><StatusBadge status={source.status} /><span>{sourceMetaLabel(source, followees.length)}</span></span></span>
              </button>
              <div className="source-actions">
                <button onClick={() => void refresh(source)} disabled={busy}>刷新</button>
                {source.kind === "generic" && <button onClick={() => setActiveRuleSource(source)}>自动校准</button>}
                {source.kind === "zhihu_follow" && <button onClick={() => { void window.reader.connectZhihuFollow(); setNotice("已打开知乎登录窗口；登录完成后会自动同步。"); }}>重新登录知乎</button>}
                <button type="button" className="source-settings-button" onClick={() => setEditingSource(source)} aria-label={`配置 ${source.title}`} title="配置来源">⚙</button>
                <button className="delete-source" onClick={() => void deleteSource(source)} disabled={busy}>删除</button>
              </div>
            </div>
          ))}
          {!sources.length && <p className="empty-side">先添加一个公开 Feed 或网页。</p>}
        </div>
        <p className="privacy-note">公开来源不保存登录态；知乎关注动态仅在本机专属会话中保存登录状态，不读取 Chrome Cookie。</p>
      </aside>

      {readingEntry ? <ReaderView
        entry={readingEntry}
        source={sourceById.get(readingEntry.sourceId)}
      /> : <section className="timeline">
        <header><div><p className="eyebrow">{activeSource ? "来源内容" : "本地优先阅读器"}</p><h1>{activeSource?.title || "最新内容"}</h1></div><span className="count">{entries.filter((entry) => !entry.read).length} 未读</span></header>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice(undefined)}>×</button></div>}
        <section className="timeline-filterbar" aria-label="时间筛选">
          <label><span>时间范围</span><select value={timelineFilter.preset} onChange={(event) => chooseTimelinePreset(event.target.value as TimelineRangePreset)}>
            <option value="all">全部时间</option><option value="today">今天</option><option value="sevenDays">最近 7 天</option><option value="thirtyDays">最近 30 天</option><option value="ninetyDays">最近 90 天</option><option value="thisYear">今年</option><option value="custom">自定义日期</option>
          </select></label>
          {timelineFilter.preset === "custom" && <div className="timeline-filter-custom">
            <label><span>开始日期</span><input type="date" value={timelineFilter.startDate} onChange={(event) => setTimelineFilter((current) => ({ ...current, startDate: event.target.value }))} /></label>
            <label><span>结束日期</span><input type="date" value={timelineFilter.endDate} onChange={(event) => setTimelineFilter((current) => ({ ...current, endDate: event.target.value }))} /></label>
          </div>}
          <p className={`timeline-filter-note${timelineRange.invalid ? " is-error" : ""}`}>{timelineRange.invalid ? "结束日期不能早于开始日期。" : `显示：${timelineRange.label}；按发布时间筛选，缺失时按收集时间。`}</p>
          {timelineFilter.preset !== "all" && <button type="button" className="timeline-filter-clear" onClick={() => setTimelineFilter(DEFAULT_TIMELINE_FILTER)}>清除筛选</button>}
        </section>
        <div className="entry-list">
          {entries.map((entry) => <EntryCard key={entry.id} entry={entry} source={sourceById.get(entry.sourceId)} onRead={updateEntry} onOpen={openReader} onDismiss={dismissEntry} busy={busy} />)}
          {!entries.length && <div className="empty-state"><h2>{timelineRange.hasRange ? "该时间范围没有内容" : activeSource ? "该来源还没有内容" : "还没有内容"}</h2><p>{timelineRange.hasRange ? "可以调整日期范围，或清除时间筛选以查看全部内容。" : activeSource ? "可以刷新来源，或使用“自动校准”重新识别内容列表。" : "添加 RSS、公开文章列表页，或粘贴小红书分享链接开始。"}</p></div>}
        </div>
      </section>}

      {pending && <PreviewDialog pending={pending} onCancel={() => setPending(undefined)} onConfirm={() => void confirm()} busy={busy} />}
      {showAddSource && <AddSourceDialog
        onClose={() => setShowAddSource(false)}
        onPreview={preview}
        onZhihuStarted={async () => { setShowAddSource(false); setNotice("已打开知乎登录窗口；登录完成后会自动同步关注动态。"); await reload(); }}
        onXStarted={async () => { setShowAddSource(false); setNotice("X 已授权，正在同步关注账号的原创帖子。"); await reload(); }}
        onAcademicSaved={async () => { setShowAddSource(false); setNotice("学术作者来源已添加，正在同步公开论文记录。"); await reload(); }}
      />}
      {activeRuleSource && <CalibrationDialog source={activeRuleSource} onClose={() => setActiveRuleSource(undefined)} onSaved={async () => { setActiveRuleSource(undefined); await reload(); }} />}
      {editingSource && <SourceSettingsDialog source={editingSource} onClose={() => setEditingSource(undefined)} onSaved={async () => { setEditingSource(undefined); await reload(); }} />}
    </main>
  );
}

function EntryCard({ entry, source, onRead, onOpen, onDismiss, busy }: { entry: Entry; source?: Source; onRead: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<void>; onOpen: (entry: Entry) => void; onDismiss: (entry: Entry) => Promise<void>; busy: boolean }) {
  const date = entry.publishedAt
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.publishedAt)
    : entry.observedAt ? `收集于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.observedAt)}` : "刚刚收集";
  const providers = [...new Set((entry.origins || []).map((origin) => origin.providerLabel || origin.providerId).filter((id) => id !== source?.connectorId))];
  return <article className={`entry-card ${entry.read ? "read" : ""}`}>
    <button className="entry-main" type="button" onClick={() => onOpen(entry)} aria-label={`在应用内阅读：${entry.title}`}>
      <div className="entry-copy"><p className="entry-source">{source?.title || "已保存内容"} <span>·</span> {date}{providers.length ? <><span>·</span>{providers.join(" / ")}</> : null}</p><h2>{entry.title}</h2>{entry.summary && <p className="summary">{entry.summary}</p>}<p className="byline">{entry.author || "原文链接"}</p></div>
      {entry.imageUrl && <img src={entry.imageUrl} alt="" loading="lazy" />}
    </button>
    <div className="entry-actions"><button type="button" onClick={() => onOpen(entry)}>应用内阅读</button><button aria-label="标记已读" onClick={() => void onRead(entry, "read", !entry.read)}>{entry.read ? "未读" : "已读"}</button><button aria-label="收藏" onClick={() => void onRead(entry, "favorite", !entry.favorite)}>{entry.favorite ? "★" : "☆"}</button><button type="button" className="delete-entry" onClick={() => void onDismiss(entry)} disabled={busy}>删除</button></div>
  </article>;
}

function ReaderView({ entry, source }: {
  entry: Entry;
  source?: Source;
}) {
  const [article, setArticle] = useState<ReaderArticle>();
  const [embedded, setEmbedded] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadReaderPreferences);
  const [assistantState, setAssistantState] = useState<AssistantPanelState>("closed");
  const [imagePreview, setImagePreview] = useState<ReaderImagePreview>();
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
  }, [entry.id]);
  useEffect(() => {
    if (!imagePreview) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setImagePreview(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [imagePreview]);

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
        <button type="button" className="toolbar-icon-button ai-toggle" aria-pressed={assistantVisible} aria-label={assistantVisible ? "最小化 AI 学习" : "打开 AI 学习"} title={assistantVisible ? "最小化 AI 学习" : "打开 AI 学习"} disabled={!article} onClick={toggleAssistant}>✦</button>
        <button type="button" className="toolbar-icon-button external-button" aria-label="在浏览器中打开原文" title="在浏览器中打开原文" onClick={() => void window.reader.openExternal(entry.url)}>↗</button>
      </div>
    </header>
    <div className={`reader-workspace ${assistantVisible && article ? "reader-workspace--assistant" : ""}`}>
      <div className="reader-scroll">
        {loading && <div className="reader-loading" role="status"><span className="loading-mark" /><p>正在准备适合阅读的正文…</p></div>}
        {!loading && embedded && <div className="reader-embedded"><h1>{entry.title}</h1><p>该站点不允许自动提取正文，原文已在 Reading Hub 的受限窗口中打开。该窗口不使用外部浏览器，也不会复用登录态。</p><button type="button" className="primary-action" onClick={() => void loadArticle()}>重新打开原文</button></div>}
        {!loading && error && <div className="reader-failure"><h1>{entry.title}</h1><p>{error}</p><div><button type="button" className="primary-action" onClick={() => void loadArticle()}>重试</button><button type="button" onClick={openEmbedded}>在应用内打开原文</button></div></div>}
        {!loading && article && <article className="reader-article">
          <header><p className="eyebrow">{source?.title || "已保存内容"}</p><h1>{article.title}</h1>{(article.author || date) && <p className="reader-byline">{article.author}{article.author && date ? " · " : ""}{date}</p>}</header>
          {article.coverImageUrl && <button type="button" className="reader-cover-button" onClick={(event) => {
            const image = event.currentTarget.querySelector("img");
            if (image) previewImage(image);
          }} aria-label="放大封面图片"><img className="reader-cover" src={article.coverImageUrl} alt="" onError={handleContentError} /></button>}
          <div className="article-body" onClick={handleContentClick} onKeyDown={handleContentKeyDown} onError={handleContentError} dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
        </article>}
      </div>
      {assistantMounted && article && <ReaderAssistant
        article={article}
        sourceTitle={source?.title}
        minimized={assistantState === "minimized"}
        onMinimize={() => setAssistantState("minimized")}
        onClose={() => setAssistantState("closed")}
      />}
      {assistantState === "minimized" && article && <button type="button" className="assistant-launcher" onClick={() => setAssistantState("open")} aria-label="恢复 AI 学习助手" title="恢复 AI 学习助手">✦</button>}
    </div>
    {imagePreview && <ImagePreview image={imagePreview} onClose={() => setImagePreview(undefined)} />}
  </section>;
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

function ReaderAssistant({ article, sourceTitle, minimized, onMinimize, onClose }: {
  article: ReaderArticle;
  sourceTitle?: string;
  minimized: boolean;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId>("codex-cli");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<AiReasoningEffort>("medium");
  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeStream = useRef<ActiveAiStream>();
  const messagesElement = useRef<HTMLDivElement>(null);

  const selected = providers.find((provider) => provider.id === providerId);
  const requiresApiKey = selected?.requiresApiKey === true;
  const usingCodexCli = selected?.id === "codex-cli";
  const canConfigure = Boolean(selected && (requiresApiKey || usingCodexCli));
  const reloadProviders = useCallback(async () => {
    const next = await window.reader.listAiProviders();
    setProviders(next);
    const active = next.find((provider) => provider.id === providerId) || next[0];
    if (active) {
      setProviderId(active.id);
      setModel(active.model);
      setEffort(active.effort || "medium");
      setShowSettings(active.requiresApiKey && !active.configured);
    }
  }, [providerId]);
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
    const next = providers.find((provider) => provider.id === nextId);
    if (next) {
      setModel(next.model);
      setEffort(next.effort || "medium");
      setShowSettings(next.requiresApiKey && !next.configured);
    }
    setError(undefined);
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await window.reader.configureAiProvider({ provider: providerId, apiKey, model, effort: usingCodexCli ? effort : undefined });
      setApiKey("");
      await reloadProviders();
      setShowSettings(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function clearProvider() {
    const isCodex = selected?.id === "codex-cli";
    const message = isCodex
      ? "恢复本机 Codex CLI 的默认模型与推理强度？"
      : `清除 ${selected?.label || "该服务"} 的 API Key？`;
    if (!window.confirm(message)) return;
    setBusy(true); setError(undefined);
    try {
      await window.reader.clearAiProvider(providerId);
      setMessages([]);
      if (isCodex) { setModel("default"); setEffort("medium"); }
      await reloadProviders();
      setShowSettings(isCodex || Boolean(selected?.requiresApiKey));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    if (!selected?.configured) {
      setShowSettings(Boolean(selected?.requiresApiKey) || selected?.id === "codex-cli");
      setError(selected?.requiresApiKey ? "请先配置 API Key。" : "未检测到本机 Codex CLI。请安装并登录后重试。");
      return;
    }
    const prompt = toArticleText(article.contentHtml);
    setQuestion(""); setBusy(true); setError(undefined);
    const requestId = newAiRequestId();
    const assistantMessageId = newAiRequestId();
    activeStream.current = { requestId, assistantMessageId };
    setMessages((current) => [...current, { id: newAiRequestId(), role: "user", text }, { id: assistantMessageId, role: "assistant", text: "", streaming: true }]);
    try {
      await window.reader.startAiStream({
        requestId,
        request: {
          provider: providerId,
          question: text,
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

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitAssistantQuestion(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return <aside className={`reader-ai-panel${minimized ? " is-minimized" : ""}`} aria-label="AI 学习助手" aria-hidden={minimized}>
    <header><div><strong>AI 学习助手</strong><p>提问时才会发送当前文章的文本摘录。</p></div><div className="assistant-header-actions"><button type="button" className="panel-icon-button" onClick={onMinimize} aria-label="最小化 AI 学习助手" title="最小化">−</button><button type="button" className="panel-icon-button" onClick={onClose} aria-label="关闭 AI 学习助手" title="关闭">×</button></div></header>
    <div className="ai-provider-row"><label htmlFor="ai-provider">服务</label><select id="ai-provider" value={providerId} onChange={(event) => switchProvider(event.target.value as AiProviderId)} disabled={busy}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select>{canConfigure && <button type="button" onClick={() => setShowSettings((visible) => !visible)} disabled={busy}>设置</button>}</div>
    {!requiresApiKey && selected?.availabilityMessage && <p className="ai-provider-note">{selected.availabilityMessage}</p>}
    {showSettings && <form className="ai-settings" onSubmit={(event) => void saveSettings(event)}>
      {usingCodexCli ? <>
        <label htmlFor="codex-model">模型</label><select id="codex-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>{CODEX_CLI_MODEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        <label htmlFor="codex-effort">推理强度</label><select id="codex-effort" value={effort} onChange={(event) => setEffort(event.target.value as AiReasoningEffort)} disabled={busy}>{CODEX_EFFORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <p className="ai-settings-note">模型可用性取决于你的 Codex/ChatGPT 账户；高、极高和最大强度会延长回答时间。</p>
      </> : <>
        <label htmlFor="ai-model">模型</label><input id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder={selected?.model || "模型名称"} required />
        <label htmlFor="ai-key">API Key</label><input id="ai-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder={selected?.configured ? "留空则保留现有密钥" : "仅保存到 macOS Keychain"} required={!selected?.configured} />
      </>}
      <div><button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存设置"}</button>{selected?.configured && <button type="button" className="danger" onClick={() => void clearProvider()} disabled={busy}>{usingCodexCli ? "恢复默认" : "清除密钥"}</button>}</div>
    </form>}
    {error && <p className="error ai-error">{error}</p>}
    <div className="ai-messages" aria-live="polite" aria-busy={busy} ref={messagesElement}>{!messages.length && <p className="ai-empty">可以让 AI 解释概念、公式推导、例子或文章中的论证。回答不会保存到数据库。</p>}{messages.map((message) => <div key={message.id} className={`ai-message ${message.role}${message.error ? " error" : ""}${message.streaming ? " is-streaming" : ""}`}><strong>{message.role === "user" ? "你" : selected?.label || "AI"}</strong>{message.streaming && !message.text ? <p className="ai-streaming-status">正在生成…</p> : <AiMarkdownContent text={message.text} />}</div>)}</div>
    <form className="ai-question" onSubmit={(event) => void ask(event)}><label htmlFor="ai-question">向文章提问（Enter 发送，Shift+Enter 换行）</label><textarea id="ai-question" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={submitOnEnter} placeholder="例如：请用直觉解释这个公式的含义" disabled={busy} /><button className="primary" disabled={busy || !question.trim()}>{busy ? "回答中…" : "发送问题"}</button></form>
  </aside>;
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

function AddSourceDialog({ onClose, onPreview, onZhihuStarted, onXStarted, onAcademicSaved }: {
  onClose: () => void;
  onPreview: (url: string) => Promise<void>;
  onZhihuStarted: () => Promise<void>;
  onXStarted: () => Promise<void>;
  onAcademicSaved: () => Promise<void>;
}) {
  const [method, setMethod] = useState<AddSourceMethod>("public");
  const methods: Array<{ id: AddSourceMethod; label: string; description: string }> = [
    { id: "public", label: "网页 / Feed", description: "RSS、公开文章列表页或分享链接" },
    { id: "zhihu", label: "知乎动态", description: "授权账号的关注页公开动态" },
    { id: "x", label: "X 动态", description: "官方 API 的关注账号原创帖" },
    { id: "academic", label: "学术作者", description: "公开学术索引中的新论文" }
  ];
  const selected = methods.find((item) => item.id === method)!;
  return <Dialog title="添加来源" onClose={onClose}>
    <div className="source-method-tabs" role="tablist" aria-label="来源类型">
      {methods.map((item) => <button key={item.id} type="button" role="tab" aria-selected={method === item.id} className={method === item.id ? "selected" : ""} onClick={() => setMethod(item.id)}>{item.label}</button>)}
    </div>
    <p className="source-method-description">{selected.description}</p>
    {method === "public" && <PublicSourcePane onPreview={onPreview} />}
    {method === "zhihu" && <ZhihuSourcePane onStarted={onZhihuStarted} />}
    {method === "x" && <XSourcePane onStarted={onXStarted} />}
    {method === "academic" && <AcademicSourcePane onSaved={onAcademicSaved} />}
  </Dialog>;
}

function PublicSourcePane({ onPreview }: { onPreview: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true); setError(undefined);
    try { await onPreview(url.trim()); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <form className="connector-form" onSubmit={(event) => void submit(event)}>
    <label htmlFor="source-url">网址</label>
    <input id="source-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://… 或 http://…" type="url" required />
    <p className="dialog-intro">优先识别 RSS、Atom、JSON Feed；没有 Feed 时会从公开页面提取文章卡片。小红书分享链接仅作为一次性原文入口保存。</p>
    {error && <p className="error">{error}</p>}
    <div className="dialog-actions"><button className="primary" disabled={busy}>{busy ? "正在探测…" : "探测来源"}</button></div>
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
    <p className="dialog-intro">此功能使用官方 X API，不读取浏览器 Cookie。请在 X Developer Console 为你的应用配置回调地址 <code>http://127.0.0.1:43119/x/callback</code>，并填写该应用的 Client ID。</p>
    <p className="dialog-intro">授权后默认每 30–60 分钟收集关注账号的原创帖和文章型外链，过滤回复与转推。访问令牌仅保存在本机 Keychain。</p>
    <form className="connector-form" onSubmit={(event) => void submit(event)}><label htmlFor="x-client-id">X Client ID</label><input id="x-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Developer App Client ID" autoComplete="off" required />{error && <p className="error">{error}</p>}<div className="dialog-actions"><button className="primary" disabled={busy}>{busy ? "等待授权…" : "在浏览器中授权 X"}</button></div></form>
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

function SourceSettingsDialog({ source, onClose, onSaved }: { source: Source; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(source.title);
  const [kind, setKind] = useState<SourceKind>(source.kind);
  const [pollingEnabled, setPollingEnabled] = useState(source.pollingEnabled);
  const [refresh, setRefresh] = useState<"default" | "30" | "60" | "120" | "240" | "720" | "1440">(source.refreshIntervalMinutes ? String(source.refreshIntervalMinutes) as "30" | "60" | "120" | "240" | "720" | "1440" : "default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const typeLocked = !PUBLIC_SOURCE_KINDS.includes(source.kind);
  const manual = kind === "manual";

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await window.reader.updateSourceSettings(source.id, {
        title,
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

  return <Dialog title={`配置「${source.title}」`} onClose={onClose}>
    <form className="source-settings-form" onSubmit={(event) => void save(event)}>
      <label>来源名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required autoFocus /></label>
      <label>信源类型<select value={kind} onChange={(event) => setKind(event.target.value as SourceKind)} disabled={typeLocked || busy}>
        {typeLocked ? <option value={source.kind}>{sourceKindLabel(source.kind)}</option> : PUBLIC_SOURCE_KINDS.map((item) => <option key={item} value={item}>{sourceKindLabel(item)}</option>)}
      </select></label>
      {typeLocked && <p className="source-settings-note">授权平台的类型及账号绑定由内置连接器管理；这里仍可调整名称和刷新频率。</p>}
      <label className="source-settings-toggle"><input type="checkbox" checked={!manual && pollingEnabled} onChange={(event) => setPollingEnabled(event.target.checked)} disabled={manual || busy} />自动刷新</label>
      <label>刷新时间<select value={refresh} onChange={(event) => setRefresh(event.target.value as typeof refresh)} disabled={manual || !pollingEnabled || busy}>{REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {manual && <p className="source-settings-note">分享链接是一次性阅读卡片，不会自动轮询。</p>}
      <label>来源地址<input value={source.url} readOnly aria-readonly="true" /></label>
      <dl className="source-settings-details"><div><dt>当前状态</dt><dd><StatusBadge status={source.status} /></dd></div><div><dt>实际连接器</dt><dd>{sourceKindLabel(source.connectorId || source.kind)}</dd></div></dl>
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
  return { rss: "RSS / Atom / JSON Feed", generic: "公开网页", manual: "分享链接", zhihu: "知乎官方数据", zhihu_follow: "知乎关注动态", x: "X 关注动态", academic: "学术作者更新" }[kind];
}

function sourceScheduleLabel(source: Source): string {
  if (!source.pollingEnabled) return "一次性保存";
  if (!source.refreshIntervalMinutes) return "30–60 分钟";
  return REFRESH_OPTIONS.find((option) => Number(option.value) === source.refreshIntervalMinutes)?.label || `约 ${source.refreshIntervalMinutes} 分钟`;
}

function sourceMetaLabel(source: Source, followeeCount: number): string {
  const prefix = source.kind === "zhihu_follow" ? "授权会话" : source.kind === "zhihu" ? `官方数据 · ${followeeCount} 位关注` : source.kind === "x" ? "官方 API · 原创帖" : source.kind === "academic" ? "公开学术索引" : undefined;
  return prefix ? `${prefix} · ${sourceScheduleLabel(source)}` : sourceScheduleLabel(source);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请稍后重试。"; }
