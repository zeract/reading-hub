import { type FormEvent, useCallback, useEffect, useState } from "react";
import { CODEX_CLI_MODEL_OPTIONS, type AiProviderId, type AiProviderSettings, type AiReasoningEffort } from "../shared/types";
import { CODEX_EFFORT_OPTIONS } from "./ai-options";
import { errorMessage } from "./errors";
import { adjustReaderFontScale, loadReaderPreferences, saveReaderPreferences, type ReaderPreferences } from "./reader-preferences";
import { AppIcon } from "./ui-icons";

type SettingsSection = "reading" | "ai";

/** Global preferences live in a dedicated view so the article surface stays for reading. */
export function SettingsView({ onClose, windowFullscreen }: { onClose: () => void; windowFullscreen: boolean }) {
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
    saveReaderPreferences(preferences);
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
    fontScale: adjustReaderFontScale(current.fontScale, amount)
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
