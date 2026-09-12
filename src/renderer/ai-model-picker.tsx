import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AiModelCatalog, AiProviderSettings } from "../shared/types";

/** Late provider/refresh responses must never replace another provider's draft. */
export function AiModelPicker({ provider, model, effort, disabled, onModel, onEffort }: {
  provider: AiProviderSettings; model: string; effort: string; disabled: boolean;
  onModel(value: string): void; onEffort(value: string): void;
}) {
  const listId = useId();
  const [catalog, setCatalog] = useState<AiModelCatalog>({ models: [], stale: true });
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const local = provider.id === "codex-cli";
  const reload = useCallback(async (refresh = false) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      let result = await window.reader.listAiModels(provider.id, refresh);
      if (current !== generation.current) return;
      setCatalog(result);
      if (!refresh && result.stale) {
        result = await window.reader.listAiModels(provider.id, true);
        if (current !== generation.current) return;
        setCatalog(result);
      }
    } catch {
      if (current === generation.current) setCatalog(previous => ({ ...previous, stale: true, error: "无法读取模型列表，已有选择保持不变。" }));
    } finally { if (current === generation.current) setLoading(false); }
  }, [provider]);
  useEffect(() => {
    setCatalog({ models: [], stale: true });
    void reload();
    return () => { generation.current++; };
  }, [reload]);
  const selected = catalog.models.find(option => model === "default" ? option.isDefault : option.id === model);
  const efforts = selected?.efforts ?? [];
  const models = local ? [{ id: "default", label: "跟随本机 Codex 默认模型" }, ...catalog.models.filter(option => option.id !== "default")] : catalog.models;
  const missing = Boolean(model && !models.some(option => option.id === model));
  function chooseModel(value: string) {
    onModel(value);
    // Only an explicit model change changes the effort draft. Refreshes never do.
    onEffort("default");
  }
  return <>
    {local ? <label>模型<select value={model} onChange={event => chooseModel(event.target.value)} disabled={disabled}>
      {missing && <option value={model}>{model}（已保存，未在当前列表中）</option>}
      {models.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label> : <label>模型<input list={listId} value={model} onChange={event => onModel(event.target.value)} placeholder="选择或输入模型名称" required disabled={disabled} />
      <datalist id={listId}>{models.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</datalist>
    </label>}
    <div className="settings-actions"><button type="button" onClick={() => void reload(true)} disabled={disabled || loading}>{loading ? "正在获取模型…" : "刷新模型"}</button></div>
    <p className="settings-help" role="status">{catalog.error || (catalog.updatedAt ? `${catalog.stale ? "使用缓存；" : ""}模型列表更新于 ${new Date(catalog.updatedAt).toLocaleString()}` : "首次获取模型列表。API 服务请先保存密钥。")}</p>
    {local ? <>
      <label>推理强度<select value={effort} onChange={event => onEffort(event.target.value)} disabled={disabled}>
        <option value="default">跟随所选模型默认值{selected?.defaultEffort ? `（${selected.defaultEffort}）` : ""}</option>
        {effort !== "default" && !efforts.includes(effort) && <option value={effort}>{effort}（已保存，当前能力未确认）</option>}
        {efforts.filter(value => value !== "default").map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <p className="settings-help">模型和推理强度由本机 Codex 提供；未列出的已保存配置仍保留，可用性以实际请求为准。</p>
    </> : <p className="settings-help">可手动输入新模型名称。列表中的模型仍需支持当前服务的文本问答接口。</p>}
  </>;
}
