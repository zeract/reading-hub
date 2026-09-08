import { facetIdentity, sameSubscriptionScope } from "../shared/subscription-scope";
import { isRetiredXPublicProfile, sourceCapabilities, sourceHealthLabel } from "../shared/source-capabilities";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ModalSurface } from "./modal-surface";
import { useAsyncAction } from "./use-async-action";
import type { PendingPreview } from "../shared/ipc";
import type {
  CalibrationResult,
  OpmlImportResult,
  Source,
  SourceCollectionSettings,
  Facet,
  SourceKind,
  SubscriptionDraft,
  SubscriptionScope
} from "../shared/types";

type AddSourceMethod = "public" | "zhihu" | "x" | "xiaohongshu" | "academic";

export function PreviewDialog({ pending, onCancel, onConfirm }: { pending: PendingPreview; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const { probe } = pending;
  const { busy, error, run } = useAsyncAction();

  return <Dialog title="确认来源" onClose={onCancel} className="dialog--preview">
    <div className="preview-dialog__body">
      <p className="dialog-intro"><strong className="preview-source-title" title={probe.title}>{probe.title}</strong><br />{probe.kind === "rss" ? "已发现 Feed，将自动更新。" : probe.kind === "manual" ? "小红书分享链接将作为一次性卡片保存。" : probe.requiresReview ? "结构识别置信度较低，保存后需要校正规则。" : "已识别公开页面结构，将自动更新。"}</p>
      <div className="preview-list preview-list--source" role="list" aria-label="识别到的文章">
        {probe.preview.slice(0, 4).map((entry) => {
          const title = entry.title.trim() || "未命名文章";
          const summary = entry.summary?.trim() || entry.url;
          return <div key={entry.url} role="listitem"><strong title={title}>{title}</strong><span title={summary}>{summary}</span></div>;
        })}
      </div>
      {busy && <p className="source-settings-note" role="status">来源正在保存，关闭窗口不会中止操作。</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions dialog-actions--fixed"><button type="button" onClick={onCancel}>{busy ? "关闭" : "取消"}</button><button type="button" className="primary" onClick={() => void run(onConfirm)} disabled={busy}>{busy ? "保存中…" : "保存来源"}</button></div>
  </Dialog>;
}

export function AddSourceDialog({ onClose, onPreview, onImportOpml, onZhihuStarted, onXStarted, onXiaohongshuSaved, onAcademicSaved }: {
  onClose: () => void;
  onPreview: (preview: PendingPreview) => void;
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
    <details open={method !== "public"}><summary>连接账号或追踪作者</summary><div className="source-method-tabs" role="tablist" aria-label="来源类型">
      {methods.map((item) => <button key={item.id} type="button" role="tab" aria-selected={method === item.id} className={method === item.id ? "selected" : ""} onClick={() => setMethod(item.id)}>{item.label}</button>)}
    </div>
    </details>
    <p className="source-method-description">{selected.description}</p>
    {method === "public" && <PublicSourcePane onPreview={onPreview} onImportOpml={onImportOpml} />}
    {method === "zhihu" && <ZhihuSourcePane onStarted={onZhihuStarted} />}
    {method === "x" && <XSourcePane onStarted={onXStarted} />}
    {method === "xiaohongshu" && <XiaohongshuSourcePane onSaved={onXiaohongshuSaved} />}
    {method === "academic" && <AcademicSourcePane onSaved={onAcademicSaved} />}
  </Dialog>;
}

function PublicSourcePane({ onPreview, onImportOpml }: { onPreview: (preview: PendingPreview) => void; onImportOpml: () => Promise<OpmlImportResult> }) {
  const [url, setUrl] = useState("");
  const [imported, setImported] = useState<string>();
  const { busy, error, run, invalidate, clearError } = useAsyncAction();
  const operation = useRef<"preview" | "import" | undefined>(undefined);

  function editUrl(value: string) {
    setUrl(value);
    if (operation.current === "preview") invalidate();
    else clearError();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    await run(async (isCurrent) => {
      operation.current = "preview";
      const result = await window.reader.previewSource(url.trim());
      if (isCurrent()) onPreview(result);
    });
  }
  async function importFile() {
    await run(async (isCurrent) => {
      operation.current = "import";
      setImported(undefined);
      const result = await onImportOpml();
      if (isCurrent() && !result.cancelled) setImported(`已导入 ${result.imported} 个 Feed${result.existing ? `；${result.existing} 个已存在` : ""}${result.skipped ? `；跳过 ${result.skipped} 个` : ""}。`);
    });
  }
  return <form className="connector-form" onSubmit={(event) => void submit(event)}>
    <label htmlFor="source-url">网址</label>
    <input id="source-url" value={url} onChange={(event) => editUrl(event.target.value)} placeholder="https://… 或 http://…" type="url" required />
    <p className="dialog-intro">优先识别 RSS、Atom、JSON Feed；没有 Feed 时会从公开页面提取文章卡片。也可导入 OPML。明确添加的本机地址仅接受 RSS/Atom/JSON Feed，不能用于网页提取。X 主页请在“X 动态”中使用官方 API。</p>
    {error && <p className="error">{error}</p>}
    {imported && <p className="source-settings-note">{imported}</p>}
    <div className="dialog-actions"><button type="button" onClick={() => void importFile()} disabled={busy}>导入 OPML…</button><button className="primary" disabled={busy}>{busy ? "正在探测…" : "探测来源"}</button></div>
  </form>;
}

function ZhihuSourcePane({ onStarted }: { onStarted: () => Promise<void> }) {
  const { busy, error, run } = useAsyncAction();
  async function submit() {
    await run(async () => {
      await window.reader.connectZhihuFollow();
      await onStarted();
    });
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
  const { busy, error, run } = useAsyncAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await window.reader.connectX(clientId);
      await onStarted();
    });
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
  const { busy, error, run } = useAsyncAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    await run(async () => {
      await window.reader.subscribeXiaohongshuProfile({ url: url.trim(), title: title.trim() || undefined });
      await onSaved();
    });
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
  const { busy, error, run, invalidate, clearError } = useAsyncAction();
  const operation = useRef<"search" | "subscribe" | undefined>(undefined);

  function editQuery(value: string) {
    setQuery(value); setResults([]);
    if (operation.current === "search") invalidate();
    else clearError();
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    await run(async (isCurrent) => {
      operation.current = "search";
      setResults([]);
      const found = await window.reader.searchAcademicAuthors(query.trim());
      if (isCurrent()) setResults(found);
    });
  }
  async function choose(draft: SubscriptionDraft) {
    await run(async () => {
      operation.current = "subscribe";
      await window.reader.subscribeAcademicAuthor(draft);
      await onSaved();
    });
  }
  return <section className="source-method-pane">
    <p className="dialog-intro">从 OpenAlex、Semantic Scholar 与可公开读取的 ORCID works 中聚合论文；卡片会保留实际来源。它不是 Google Scholar 页面同步，也不读取 Scholar 登录态或邮件。</p>
    <form className="connector-form" onSubmit={(event) => void search(event)}><label htmlFor="academic-query">作者姓名</label><div className="connector-search"><input id="academic-query" value={query} onChange={(event) => editQuery(event.target.value)} placeholder="例如 Geoffrey Hinton" /><button className="primary" disabled={busy}>搜索</button></div></form>
    {results.length > 0 && <div className="academic-results">{results.map((draft, index) => <button type="button" key={`${draft.targetId}-${index}`} onClick={() => void choose(draft)} disabled={busy}><strong>{draft.title}</strong><span>{draft.config?.orcid ? `ORCID ${String(draft.config.orcid)}` : "确认此作者"}</span></button>)}</div>}
    {error && <p className="error">{error}</p>}
  </section>;
}

export function CalibrationDialog({ source, onClose, onSaved }: { source: Source; onClose: () => void; onSaved: () => Promise<void> }) {
  const [result, setResult] = useState<CalibrationResult>();
  const [pending, setPending] = useState<"refresh" | "reload">();
  const { busy, error, run, invalidate } = useAsyncAction();
  const detect = useCallback(async () => {
    await run(async (isCurrent) => {
      setResult(undefined);
      setPending(undefined);
      const detected = await window.reader.calibrateSource(source.id);
      if (isCurrent()) setResult(detected);
    });
  }, [source.id, run]);
  useEffect(() => { void detect(); return invalidate; }, [detect, invalidate]);

  async function finish(isCurrent: () => boolean, stage: "refresh" | "reload") {
    if (stage === "refresh") {
      await window.reader.refreshSource(source.id);
      if (isCurrent()) setPending("reload");
    }
    await onSaved();
    if (isCurrent()) setPending(undefined);
  }

  async function apply(candidate: CalibrationResult["candidates"][number]) {
    if (pending) return;
    await run(async (isCurrent) => {
      await window.reader.updateRule(source.id, candidate.rule);
      // Rule confirmation resets collected origins. After it commits, retry
      // only the unfinished follow-up, never the destructive write itself.
      if (isCurrent()) setPending("refresh");
      await finish(isCurrent, "refresh");
    });
  }
  return <Dialog title={`自动校准「${source.title}」`} onClose={onClose}>
    <p className="dialog-intro">无需了解 CSS。请从下方候选中选择一组看起来像该网站文章列表的卡片；应用会保存规则、移除之前误识别的卡片，并立即验证。</p>
    {busy && !result && <p className="dialog-intro">正在分析网页结构…</p>}
    {result?.candidates.map((candidate, index) => <section className="calibration-candidate" key={`${candidate.label}-${index}`}><div><strong>{candidate.label}</strong><span>识别置信度 {Math.round(candidate.confidence * 100)}%</span></div><div className="preview-list">{candidate.preview.slice(0, 2).map((entry) => <div key={entry.url}><strong>{entry.title}</strong><span>{entry.summary || entry.url}</span></div>)}</div><button className="primary" onClick={() => void apply(candidate)} disabled={busy || Boolean(pending)}>这组内容是正确的</button></section>)}
    {result && !result.candidates.length && <p className="dialog-intro">{result.message}</p>}
    {pending && <p className="source-settings-note calibration-status" role="status">{pending === "refresh" ? "规则已保存，来源刷新尚未完成。" : "规则已保存且来源已刷新，列表更新尚未完成。"}{busy ? "正在处理…" : "可重试继续，或关闭窗口稍后刷新。"}</p>}
    {error && <p className="error calibration-error" role="alert" tabIndex={0}>{error}</p>}
    <div className="dialog-actions"><button type="button" onClick={onClose}>{pending || busy ? "关闭" : "取消"}</button><button type="button" onClick={() => void detect()} disabled={busy || Boolean(pending)}>重新自动检测</button>{pending && <button type="button" className="primary" disabled={busy} onClick={() => void run((isCurrent) => finish(isCurrent, pending))}>{pending === "refresh" ? "重试刷新" : "重试更新列表"}</button>}</div>
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

export { isRetiredXPublicProfile } from "../shared/source-capabilities";

export function SourceSettingsDialog({ source, onClose, onSaved, onRefresh, onCalibrate, onDelete, onReconnectZhihu }: {
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
  const [collection, setCollection] = useState<SourceCollectionSettings>();
  const [initialCollectionScope, setInitialCollectionScope] = useState<SubscriptionScope>();
  const refreshPending = useRef(false);
  const { busy, error, run } = useAsyncAction();
  const { busy: collectionLoading, error: collectionError, run: readCollection, invalidate: invalidateCollection } = useAsyncAction();
  const legacyRssHubFeed = source.config?.sourceProvider === "rsshub";
  const retiredXPublicProfile = isRetiredXPublicProfile(source);
  const capabilities = sourceCapabilities(source);
  const typeLocked = !capabilities.canChangeKind;
  const manual = kind === "manual";

  const loadCollection = useCallback(() => readCollection(async (isCurrent) => {
    setCollection(undefined);
    setInitialCollectionScope(undefined);
    const settings = await window.reader.getSourceCollectionSettings(source.id);
    if (!isCurrent()) return;
    setCollection(settings);
    setInitialCollectionScope(settings.scope);
  }), [readCollection, source.id]);
  useEffect(() => {
    void loadCollection();
    return invalidateCollection;
  }, [loadCollection, invalidateCollection]);

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async (isCurrent) => {
      await window.reader.updateSourceSettings(source.id, {
        title,
        category,
        kind,
        pollingEnabled: manual ? false : pollingEnabled,
        refreshIntervalMinutes: !manual && pollingEnabled && refresh !== "default" ? Number(refresh) : undefined
      });
      // Changing a public source kind resets its connector subscription in
      // the database. Never replay the outgoing connector's category IDs
      // onto the newly selected connector: doing so could make a generic or
      // manual source appear empty until it happens to emit identical tags.
      const scopeChanged = kind === source.kind
        && Boolean(collection && initialCollectionScope && !sameSubscriptionScope(collection.scope, initialCollectionScope));
      if (scopeChanged && collection) {
        const persisted = await window.reader.updateSourceCollectionScope(source.id, collection.scope);
        refreshPending.current = true;
        if (isCurrent()) {
          setCollection(persisted);
          setInitialCollectionScope(persisted.scope);
        }
      }
      // Scope persistence and its requested refresh are separate steps.
      // Keep the refresh pending on failure so retry does not silently skip
      // it just because the scope itself has already been saved.
      if (manual || !capabilities.canPoll || !pollingEnabled) refreshPending.current = false;
      if (refreshPending.current) await refreshSource();
      await onSaved();
    });
  }

  async function refreshSource() {
    await onRefresh();
    refreshPending.current = false;
  }

  async function inspectCollectionFacets() {
    await run(async (isCurrent) => {
      const facets = await window.reader.inspectSourceCollectionFacets(source.id);
      if (isCurrent()) setCollection((current) => current ? { ...current, facets } : current);
    });
  }

  function updateCollectionScope(update: (scope: SubscriptionScope) => SubscriptionScope) {
    setCollection((current) => current ? { ...current, scope: update(current.scope) } : current);
  }

  return <Dialog title={`配置「${source.title}」`} onClose={onClose} className="dialog--source-settings">
    <form className="source-settings-form" onSubmit={(event) => void save(event)}>
      <div className="source-settings-body">
        <label>来源名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required autoFocus disabled={busy} /></label>
        <label>来源文件夹<input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={60} placeholder="留空则自动归类" disabled={busy} /></label>
        <p className="source-settings-note">来源文件夹仅保存在本机，用于将来源整理为可折叠的分组；它不会过滤文章。</p>
        <details><summary>高级设置</summary><label>信源类型<select value={kind} onChange={(event) => setKind(event.target.value as SourceKind)} disabled={typeLocked || busy}>
          {typeLocked ? <option value={source.kind}>{sourceKindLabel(source.kind)}</option> : PUBLIC_SOURCE_KINDS.map((item) => <option key={item} value={item}>{sourceKindLabel(item)}</option>)}
        </select></label>
        {typeLocked && <p className="source-settings-note">{retiredXPublicProfile ? "此旧 X 公开来源已停止刷新：X 没有提供可合规自动读取的公开订阅接口。已有卡片会保留；如需继续同步，请删除它后使用官方 API。" : legacyRssHubFeed ? "已保存的 RSSHub Feed 仍使用 RSS 连接器；这里可调整名称和刷新频率。" : "平台来源的类型及账号绑定由内置连接器管理；这里仍可调整名称和刷新频率。"}</p>}
        </details>
        <label className="source-settings-toggle"><input type="checkbox" checked={!manual && pollingEnabled} onChange={(event) => setPollingEnabled(event.target.checked)} disabled={manual || !capabilities.canPoll || busy} />自动刷新</label>
        <label>刷新时间<select value={refresh} onChange={(event) => setRefresh(event.target.value as typeof refresh)} disabled={manual || retiredXPublicProfile || !pollingEnabled || busy}>{REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {manual && <p className="source-settings-note">分享链接是一次性阅读卡片，不会自动轮询。</p>}
        <label>来源地址<input value={source.url} readOnly aria-readonly="true" /></label>
        {!collection && <fieldset className="source-collection-scope source-collection-load" aria-busy={collectionLoading}>
          <legend>文章收集范围</legend>
          {collectionError ? <>
            <p className="source-collection-error" role="alert" tabIndex={0}>无法读取收集范围。{collectionError}</p>
            <p className="source-settings-note">可重试读取；名称和文件夹仍可保存。</p>
            <button type="button" className="action-button" disabled={busy || collectionLoading} onClick={() => void loadCollection()}>重新读取范围</button>
          </> : <p className="source-settings-note" role="status">正在读取收集范围…</p>}
        </fieldset>}
        {collection && <CollectionScopeEditor
          source={source}
          settings={collection}
          savedScope={initialCollectionScope}
          disabled={busy}
          onInspect={() => void inspectCollectionFacets()}
          onChange={updateCollectionScope}
        />}
        <dl className="source-settings-details"><div><dt>当前状态</dt><dd>{sourceHealthLabel(source)}</dd></div><div><dt>实际连接器</dt><dd>{sourceConnectorLabel(source)}</dd></div></dl>
        {source.lastError && <p className="error">{source.lastError}</p>}
        <p className="source-settings-note">最近成功：{source.lastSuccessfulAt ? new Date(source.lastSuccessfulAt).toLocaleString("zh-CN") : "尚未检查"}；下次检查：{source.nextCheckAt && capabilities.canRefresh ? new Date(source.nextCheckAt).toLocaleString("zh-CN") : "未安排"}</p>
        <div className="source-settings-operations">{capabilities.canRefresh && <button type="button" onClick={() => void run(refreshSource)} disabled={busy}>立即刷新</button>}{capabilities.canCalibrate && <button type="button" onClick={() => void run(onCalibrate)} disabled={busy}>自动校准</button>}{capabilities.canReconnect && <button type="button" onClick={() => void run(onReconnectZhihu)} disabled={busy}>重新登录知乎</button>}<button type="button" className="danger" onClick={() => void run(onDelete)} disabled={busy || (source.subscribed === false && !capabilities.canSubscribe)}>{source.subscribed === false ? "重新订阅" : "取消订阅"}</button><button type="button" className="danger" disabled={busy} onClick={() => void run(async () => {
          if (!window.confirm("清理该来源独有且未收藏的内容？其他来源共享的内容和收藏会保留。")) return;
          await window.reader.clearSourceContent(source.id); await onSaved();
        })}>清理未收藏内容</button></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!busy && refreshPending.current && <p className="source-settings-note" role="status">收集范围已保存，刷新尚未完成。点击“保存配置”可重试。</p>}
      <div className="dialog-actions dialog-actions--fixed"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy ? "正在处理…" : "保存配置"}</button></div>
    </form>
  </Dialog>;
}

type CollectionFacetOption = Facet & { entryCount?: number; retained: boolean };

/** Saved and edited filters remain actionable after their last local article or
 * publisher catalog entry disappears. Catalog metadata takes precedence. */
function collectionFacetOptions(settings: SourceCollectionSettings, retainedFacets: readonly Facet[]): CollectionFacetOption[] {
  const options = new Map<string, CollectionFacetOption>();
  for (const facet of settings.facets) options.set(facetIdentity(facet), { ...facet, retained: false });
  for (const facet of [...retainedFacets, ...settings.scope.facetSelections]) {
    const id = facetIdentity(facet);
    if (!options.has(id)) options.set(id, { ...facet, retained: true });
  }
  return [...options.values()];
}

function CollectionScopeEditor({ source, settings, savedScope, disabled, onInspect, onChange }: {
  source: Source;
  settings: SourceCollectionSettings;
  savedScope?: SubscriptionScope;
  disabled: boolean;
  onInspect: () => void;
  onChange: (update: (scope: SubscriptionScope) => SubscriptionScope) => void;
}) {
  // Choices touched during this edit stay reversible even if a later
  // discovery omits them. Only scope selections are sent when saving.
  const [touchedFacets, setTouchedFacets] = useState<Facet[]>([]);
  const canInspectFacets = settings.facetDiscoveryAvailable === true;
  const canImportHistory = settings.historyAvailable === true;
  const facets = collectionFacetOptions(settings, [...(savedScope?.facetSelections || []), ...touchedFacets]);
  if (!canInspectFacets && !canImportHistory && !facets.length) return null;
  const { scope } = settings;
  const selectedIds = new Set(scope.facetSelections.map(facetIdentity));
  const canImportSelectedHistory = scope.facetSelections.length > 0;

  function toggleFacet(facet: Facet) {
    setTouchedFacets((current) => current.some((item) => facetIdentity(item) === facetIdentity(facet))
      ? current : [...current, { scheme: facet.scheme, key: facet.key, label: facet.label }]);
    onChange((current) => {
      const id = facetIdentity(facet);
      const facetSelections = current.facetSelections.some((item) => facetIdentity(item) === id)
        ? current.facetSelections.filter((item) => facetIdentity(item) !== id)
        : [...current.facetSelections, { scheme: facet.scheme, key: facet.key, label: facet.label }];
      return {
        ...current,
        facetSelections,
        history: current.history.mode === "all"
          ? { mode: "none" }
          : current.history.mode === "selected" && !facetSelections.length
            ? { mode: "none" }
            : current.history
      };
    });
  }

  function setHistory(mode: SubscriptionScope["history"]["mode"]) {
    onChange((current) => ({
      ...current,
      facetSelections: mode === "all" ? [] : current.facetSelections,
      history: mode === "none" ? { mode } : {
        mode,
        ...(current.history.limit === undefined ? { limit: 100 } : { limit: current.history.limit })
      }
    }));
  }

  function setHistoryLimit(limit: number) {
    onChange((current) => ({ ...current, history: { ...current.history, limit } }));
  }

  return <fieldset className="source-collection-scope">
    <legend>文章收集范围</legend>
    <p className="source-settings-note">文章分类只采用 Feed 或公开归档中已声明的标签；不会根据标题猜测，也不会与“来源文件夹”混用。</p>
    <div className="source-collection-scope__heading">
      <strong>文章分类</strong>
      {canInspectFacets && <button type="button" className="action-button" onClick={onInspect} disabled={disabled}>读取可用分类</button>}
    </div>
    {facets.length > 0 ? <div className="facet-options" role="group" aria-label="文章分类">
      {facets.map((facet) => <label className="facet-option" key={facetIdentity(facet)}>
        <input type="checkbox" checked={selectedIds.has(facetIdentity(facet))} onChange={() => toggleFacet(facet)} disabled={disabled} />
        <span title={facet.label}>{facet.label}</span>{facet.entryCount !== undefined && facet.entryCount > 0 && <em>{facet.entryCount} 篇</em>}
      </label>)}
    </div> : <p className="source-settings-note">尚未发现可验证的文章分类。{canInspectFacets ? "可读取公开归档中的分类标签。" : "此来源将收集全部当前更新。"}</p>}
    <p className="source-settings-note">{scope.facetSelections.length ? `已选 ${scope.facetSelections.length} 个分类；之后只保留匹配的更新。` : "未选择分类：将保留当前 Feed 的全部更新。"}</p>
    {facets.some((facet) => facet.retained && selectedIds.has(facetIdentity(facet))) && <p className="source-settings-note">部分已选分类当前未出现在可用列表中，仍会参与筛选；取消勾选可移除。</p>}
    {canImportHistory && <div className="history-options" role="group" aria-label="历史文章范围">
      <strong>历史文章</strong>
      <label><input type="radio" name={`history-${source.id}`} checked={scope.history.mode === "none"} onChange={() => setHistory("none")} disabled={disabled} />只收集当前 Feed（默认）</label>
      <label><input type="radio" name={`history-${source.id}`} checked={scope.history.mode === "selected"} onChange={() => setHistory("selected")} disabled={disabled || !canImportSelectedHistory} />按所选分类补充公开历史</label>
      <label><input type="radio" name={`history-${source.id}`} checked={scope.history.mode === "all"} onChange={() => setHistory("all")} disabled={disabled} />补充全部公开历史（不筛选分类）</label>
      {scope.history.mode !== "none" && <label className="history-limit">最多导入<select value={scope.history.limit ?? 100} onChange={(event) => setHistoryLimit(Number(event.target.value))} disabled={disabled}>
        {[50, 100, 300, 1_000, 5_000].map((limit) => <option key={limit} value={limit}>{limit} 篇</option>)}
      </select></label>}
    </div>}
  </fieldset>;
}

export function Dialog({ title, children, onClose, className }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  return <ModalSurface className="modal-backdrop" title={title} onClose={onClose}><section className={`dialog${className ? ` ${className}` : ""}`}><header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></header>{children}</section></ModalSurface>;
}

const SOURCE_KIND_LABELS = {
  rss: "RSS / Atom / JSON Feed",
  generic: "公开网页",
  manual: "分享链接",
  zhihu: "知乎官方数据",
  zhihu_follow: "知乎关注动态",
  x: "X 关注动态",
  xiaohongshu: "小红书公开博主",
  academic: "学术作者更新"
} satisfies Record<SourceKind, string>;

function sourceKindLabel(kind: SourceKind): string {
  return SOURCE_KIND_LABELS[kind];
}

function sourceConnectorLabel(source: Source): string {
  const connectorId = source.connectorId;
  if (!connectorId) return sourceKindLabel(source.kind);
  return isSourceKind(connectorId) ? SOURCE_KIND_LABELS[connectorId] : `内置连接器：${connectorId}`;
}

function isSourceKind(value: string): value is SourceKind {
  return Object.hasOwn(SOURCE_KIND_LABELS, value);
}
