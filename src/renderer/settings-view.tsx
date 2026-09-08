import { type FormEvent, useCallback, useEffect, useState } from "react";
import { CODEX_CLI_MODEL_OPTIONS, type AiProviderId, type AiProviderSettings, type AiReasoningEffort } from "../shared/types";
import { CODEX_EFFORT_OPTIONS } from "./ai-options";
import { ReaderPreferenceStatus, useReaderPreferences } from "./reader-preferences-context";
import { AppIcon } from "./ui-icons";
import { useAsyncAction } from "./use-async-action";
import { errorMessage } from "./errors";

type SettingsSection = "reading" | "ai";

/** Global preferences live in a dedicated view so the article surface stays for reading. */
export function SettingsView({ onClose, windowFullscreen }: { onClose: () => void; windowFullscreen: boolean }) {
  const [section, setSection] = useState<SettingsSection>("reading");
  const { preferences, setPreset, adjustFont } = useReaderPreferences();
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId>("codex-cli");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<AiReasoningEffort>("medium");
  const [apiKey, setApiKey] = useState("");
  const { busy, error, run, clearError, isRunning } = useAsyncAction();
  const [providerState, setProviderState] = useState<"loading" | "ready" | "error">("loading");
  const [providerError, setProviderError] = useState<string>();
  const [updateCommitted, setUpdateCommitted] = useState(false);

  const reloadProviders = useCallback(async (isCurrent: () => boolean, preferredId: AiProviderId) => {
    setProviderState("loading");
    setProviderError(undefined);
    try {
      const next = await window.reader.listAiProviders();
      if (!isCurrent()) return;
      const active = next.find((provider) => provider.id === preferredId) || next[0];
      if (!active) throw new Error("没有可用的 AI 服务，请重新读取配置。");
      setProviders(next);
      setProviderId(active.id);
      setModel(active.model);
      setEffort(active.effort || "medium");
      setProviderState("ready");
      setUpdateCommitted(false);
    } catch (reason) {
      if (!isCurrent()) return;
      setProviderError(errorMessage(reason));
      setProviderState("error");
    }
  }, []);

  useEffect(() => {
    void run((isCurrent) => reloadProviders(isCurrent, "codex-cli"));
  }, [reloadProviders, run]);

  const selected = providers.find((provider) => provider.id === providerId);
  const usingLocalCodex = selected?.id === "codex-cli";
  const requiresApiKey = selected?.requiresApiKey === true;

  const controlsDisabled = busy || providerState !== "ready";

  function switchProvider(nextId: AiProviderId) {
    if (isRunning() || providerState !== "ready") return;
    const next = providers.find((provider) => provider.id === nextId);
    setProviderId(nextId);
    setModel(next?.model || "");
    setEffort(next?.effort || "medium");
    setApiKey("");
    clearError();
  }

  async function updateAiSettings(update: () => Promise<unknown>) {
    if (!selected || providerState !== "ready") return;
    await run(async (isCurrent) => {
      await update();
      if (!isCurrent()) return;
      setApiKey("");
      setUpdateCommitted(true);
      await reloadProviders(isCurrent, providerId);
    });
  }

  async function saveAiSettings(event: FormEvent) {
    event.preventDefault();
    await updateAiSettings(() => window.reader.configureAiProvider({
      provider: providerId,
      apiKey,
      model,
      effort: usingLocalCodex ? effort : undefined
    }));
  }

  async function clearAiSettings() {
    if (!selected || isRunning() || providerState !== "ready") return;
    const message = usingLocalCodex
      ? "恢复本机 Codex 的默认模型与推理强度？"
      : `清除 ${selected.label} 的 API Key？`;
    if (!window.confirm(message)) return;
    await updateAiSettings(() => window.reader.clearAiProvider(providerId));
  }

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
          <div className="settings-row"><div><strong>阅读密度</strong><span>阅读模式保留更舒适的行距；紧凑模式用于快速浏览。</span></div><div className="settings-segmented" role="group" aria-label="阅读密度"><button type="button" className={preferences.preset === "compact" ? "selected" : ""} aria-pressed={preferences.preset === "compact"} onClick={() => setPreset("compact")}>紧凑</button><button type="button" className={preferences.preset === "reading" ? "selected" : ""} aria-pressed={preferences.preset === "reading"} onClick={() => setPreset("reading")}>阅读</button></div></div>
          <div className="settings-row"><div><strong>正文字号</strong><span>当前 {Math.round(preferences.fontScale * 100)}%</span></div><div className="settings-font-controls"><button type="button" aria-label="缩小字号" onClick={() => adjustFont(-0.05)} disabled={preferences.fontScale <= 0.85}>A−</button><output>{Math.round(preferences.fontScale * 100)}%</output><button type="button" aria-label="放大字号" onClick={() => adjustFont(0.05)} disabled={preferences.fontScale >= 1.25}>A+</button></div></div>
          <ReaderPreferenceStatus />
        </section>
        <section className="settings-card settings-card--quiet"><h2>沉浸阅读</h2><p>打开任意文章后，使用阅读栏右上角的 ⛶ 可隐藏来源与文章列表，只保留正文阅读栏。</p></section>
      </> : <>
        <header><p className="eyebrow">AI 功能</p><h1>服务与连接</h1><p>密钥仅写入 macOS Keychain，不保存在数据库或页面中。</p></header>
        <form className="settings-card settings-ai-form" onSubmit={(event) => void saveAiSettings(event)}>
          <h2>AI 服务</h2>
          {providerState !== "ready" && <div className="settings-provider-feedback">
            {providerState === "loading" ? <p role="status">正在读取 AI 服务配置…</p> : <>
              <p className="settings-provider-error" role="alert" tabIndex={0}>{updateCommitted ? "设置操作已完成，但无法重新读取配置。" : "无法读取 AI 服务配置。"}{providerError}</p>
              <button type="button" className="action-button" disabled={busy} onClick={() => void run((isCurrent) => reloadProviders(isCurrent, providerId))}>重新读取</button>
            </>}
          </div>}
          <label>服务<select value={providerId} onChange={(event) => switchProvider(event.target.value as AiProviderId)} disabled={controlsDisabled}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
          {usingLocalCodex ? <>
            <label>模型<select value={model} onChange={(event) => setModel(event.target.value)} disabled={controlsDisabled}>{CODEX_CLI_MODEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label>推理强度<select value={effort} onChange={(event) => setEffort(event.target.value as AiReasoningEffort)} disabled={controlsDisabled}>{CODEX_EFFORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <p className="settings-help">模型可用性取决于 Codex/ChatGPT 账户；较高推理强度会延长回答时间。</p>
          </> : selected ? <>
            <label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder={selected?.model || "模型名称"} required disabled={controlsDisabled} /></label>
            <label>API Key<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder={selected?.configured ? "留空则保留现有密钥" : "仅保存到 macOS Keychain"} required={requiresApiKey && !selected?.configured} disabled={controlsDisabled} /></label>
          </> : null}
          {selected?.availabilityMessage && <p className="settings-help">{selected.availabilityMessage}</p>}
          {error && <p className="error settings-provider-error" role="alert" tabIndex={0}>{error}</p>}
          <div className="settings-actions"><button type="submit" className="primary" disabled={!selected || controlsDisabled}>{providerState === "loading" ? "正在读取…" : busy ? "正在保存…" : "保存设置"}</button>{selected?.configured && <button type="button" className="danger" onClick={() => void clearAiSettings()} disabled={controlsDisabled}>{usingLocalCodex ? "恢复默认" : "清除密钥"}</button>}</div>
        </form>
      </>}
    </section>
  </main>;
}
