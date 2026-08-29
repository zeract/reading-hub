import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type { CalibrationResult, OpmlImportResult, ProbeResult, Source, SourceKind, SubscriptionDraft } from "../shared/types";
import { errorMessage } from "./errors";

type PendingPreview = { token: string; probe: ProbeResult };
type AddSourceMethod = "public" | "zhihu" | "x" | "xiaohongshu" | "academic";

export function PreviewDialog({ pending, onCancel, onConfirm, busy }: { pending: PendingPreview; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const { probe } = pending;
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
    </div>
    <div className="dialog-actions dialog-actions--fixed"><button onClick={onCancel}>取消</button><button className="primary" onClick={onConfirm} disabled={busy}>保存来源</button></div>
  </Dialog>;
}

export function AddSourceDialog({ onClose, onPreview, onImportOpml, onZhihuStarted, onXStarted, onXiaohongshuSaved, onAcademicSaved }: {
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

export function CalibrationDialog({ source, onClose, onSaved }: { source: Source; onClose: () => void; onSaved: () => Promise<void> }) {
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

export function isRetiredXPublicProfile(source: Source | undefined): boolean {
  return source?.kind === "x" && source.connectorId === "x" && source.config?.mode === "public-profile";
}

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

export function Dialog({ title, children, onClose, className }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  return <div className="modal-backdrop" role="presentation"><section className={`dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="关闭">×</button></header>{children}</section></div>;
}

function StatusBadge({ status }: { status: Source["status"] }) {
  const labels = { active: "正常", needs_review: "需校正", paused: "已暂停", error: "重试中" };
  return <span className={`status ${status}`}>{labels[status]}</span>;
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
