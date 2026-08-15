import { type CSSProperties, type FormEvent, type ReactNode, type SyntheticEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { CalibrationResult, Entry, Followee, ProbeResult, ReaderArticle, Source, SubscriptionDraft } from "../shared/types";

type PendingPreview = { token: string; probe: ProbeResult };
type ReaderPreset = "reading" | "compact";
type ReaderPreferences = { preset: ReaderPreset; fontScale: number };
type AddSourceMethod = "public" | "zhihu" | "x" | "academic";

const READER_PREFERENCES_KEY = "reading-hub.reader-preferences.v1";
const DEFAULT_READER_PREFERENCES: ReaderPreferences = { preset: "reading", fontScale: 1 };

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
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [readingEntry, setReadingEntry] = useState<Entry>();

  const reload = useCallback(async () => {
    const [nextSources, nextEntries, nextFollowees] = await Promise.all([
      window.reader.listSources(),
      window.reader.listEntries(activeSourceId),
      window.reader.listFollowees()
    ]);
    setSources(nextSources);
    setEntries(nextEntries);
    setFollowees(nextFollowees);
  }, [activeSourceId]);

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

  async function deleteSource(source: Source) {
    if (!window.confirm(`删除「${source.title}」及其已收集内容？此操作无法撤销。`)) return;
    setBusy(true);
    try {
      await window.reader.deleteSource(source.id);
      if (activeSourceId === source.id) setActiveSourceId(undefined);
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
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">R</span><span>Reading Hub</span></div>
        <button type="button" className="add-source-button" onClick={() => setShowAddSource(true)}>＋ 添加来源<span>网页、平台动态或学术作者</span></button>
        <div className="section-title">来源 <span>{sources.length}</span></div>
        <div className="source-list">
          <button className={`source-filter ${!activeSourceId ? "selected" : ""}`} onClick={() => setActiveSourceId(undefined)}>
            <span className="source-title">全部内容</span><span className="source-meta">按最新时间</span>
          </button>
          {sources.map((source) => (
            <div className="source-row" key={source.id}>
              <button className={`source-filter ${activeSourceId === source.id ? "selected" : ""}`} onClick={() => setActiveSourceId(source.id)}>
                <span className="source-title">{source.title}</span>
                <span className="source-meta"><StatusBadge status={source.status} />{source.kind === "zhihu_follow" ? "授权会话 · 30–60 分钟" : source.kind === "zhihu" ? `官方数据 · ${followees.length} 位关注` : source.kind === "x" ? "官方 API · 原创帖" : source.kind === "academic" ? "公开学术索引 · 30–60 分钟" : source.pollingEnabled ? "30–60 分钟" : "一次性保存"}</span>
              </button>
              <div className="source-actions">
                <button onClick={() => void refresh(source)} disabled={busy}>刷新</button>
                {source.kind === "generic" && <button onClick={() => setActiveRuleSource(source)}>自动校准</button>}
                {source.kind === "zhihu_follow" && <button onClick={() => { void window.reader.connectZhihuFollow(); setNotice("已打开知乎登录窗口；登录完成后会自动同步。"); }}>重新登录知乎</button>}
                <button className="delete-source" onClick={() => void deleteSource(source)} disabled={busy}>删除</button>
              </div>
            </div>
          ))}
          {!sources.length && <p className="empty-side">先添加一个公开 Feed 或网页。</p>}
        </div>
        <p className="privacy-note">公开来源不保存登录态；知乎关注动态仅在本机专属会话中保存登录状态，不读取 Chrome Cookie。</p>
      </aside>

      {readingEntry ? <ReaderView entry={readingEntry} source={sourceById.get(readingEntry.sourceId)} onClose={() => setReadingEntry(undefined)} /> : <section className="timeline">
        <header><div><p className="eyebrow">{activeSource ? "来源内容" : "本地优先阅读器"}</p><h1>{activeSource?.title || "最新内容"}</h1></div><span className="count">{entries.filter((entry) => !entry.read).length} 未读</span></header>
        {notice && <div className="notice">{notice}<button onClick={() => setNotice(undefined)}>×</button></div>}
        <div className="entry-list">
          {entries.map((entry) => <EntryCard key={entry.id} entry={entry} source={sourceById.get(entry.sourceId)} onRead={updateEntry} onOpen={openReader} onDismiss={dismissEntry} busy={busy} />)}
          {!entries.length && <div className="empty-state"><h2>{activeSource ? "该来源还没有内容" : "还没有内容"}</h2><p>{activeSource ? "可以刷新来源，或使用“自动校准”重新识别内容列表。" : "添加 RSS、公开文章列表页，或粘贴小红书分享链接开始。"}</p></div>}
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

function ReaderView({ entry, source, onClose }: { entry: Entry; source?: Source; onClose: () => void }) {
  const [article, setArticle] = useState<ReaderArticle>();
  const [embedded, setEmbedded] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadReaderPreferences);
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

  const displayed = article || entry;
  const date = displayed.publishedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(displayed.publishedAt) : undefined;
  function handleContentClick(event: SyntheticEvent<HTMLElement>) {
    const link = (event.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!link) return;
    event.preventDefault();
    void window.reader.openExternal(link.href);
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

  return <section className={`reader-view reader--${article?.renderProfile || "standard"}`} data-reader-preset={preferences.preset} style={readerStyle} aria-label="应用内阅读器">
    <header className="reader-toolbar">
      <button type="button" className="back-button" onClick={onClose}>← 返回列表</button>
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
      <button type="button" className="external-button" onClick={() => void window.reader.openExternal(entry.url)}>在浏览器打开 ↗</button>
    </header>
    <div className="reader-scroll">
      {loading && <div className="reader-loading" role="status"><span className="loading-mark" /><p>正在准备适合阅读的正文…</p></div>}
      {!loading && embedded && <div className="reader-embedded"><h1>{entry.title}</h1><p>该站点不允许自动提取正文，原文已在 Reading Hub 的受限窗口中打开。该窗口不使用外部浏览器，也不会复用登录态。</p><button type="button" className="primary-action" onClick={() => void loadArticle()}>重新打开原文</button></div>}
      {!loading && error && <div className="reader-failure"><h1>{entry.title}</h1><p>{error}</p><div><button type="button" className="primary-action" onClick={() => void loadArticle()}>重试</button><button type="button" onClick={openEmbedded}>在应用内打开原文</button></div></div>}
      {!loading && article && <article className="reader-article">
        {article.mathStyleCss && <style data-reader-mathjax="true">{article.mathStyleCss}</style>}
        <header><p className="eyebrow">{source?.title || "已保存内容"}</p><h1>{article.title}</h1>{(article.author || date) && <p className="reader-byline">{article.author}{article.author && date ? " · " : ""}{date}</p>}</header>
        {article.coverImageUrl && <img className="reader-cover" src={article.coverImageUrl} alt="" onError={handleContentError} />}
        <div className="article-body" onClick={handleContentClick} onError={handleContentError} dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
      </article>}
    </div>
  </section>;
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

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>;
}

function StatusBadge({ status }: { status: Source["status"] }) {
  const labels = { active: "正常", needs_review: "需校正", paused: "已暂停", error: "重试中" };
  return <span className={`status ${status}`}>{labels[status]}</span>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请稍后重试。"; }
