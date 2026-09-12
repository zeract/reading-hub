import { useEffect, useState } from "react";
import type { AiProviderId, AiProviderSettings } from "../shared/types";
import type { RewriteSettings } from "../shared/rewrite";
import { AiModelPicker } from "./ai-model-picker";
import { useAsyncAction } from "./use-async-action";

export function RewriteSettingsCard({ providers }: { providers: AiProviderSettings[] }) {
  const [draft,setDraft]=useState<RewriteSettings>({provider:"deepseek",model:"",effort:"default"});
  const [loaded,setLoaded]=useState(false);const [saved,setSaved]=useState(false);
  const {run,busy,error}=useAsyncAction();
  const load=()=>run(async current=>{const value=await window.reader.getRewriteSettings();if(current()){if(value)setDraft(value);setLoaded(true);}});
  useEffect(()=>{void load();},[run]);
  const selected=providers.find(p=>p.id===draft.provider);
  const change=(value: Partial<RewriteSettings>)=>{setSaved(false);setDraft(previous=>({...previous,...value}));};
  return <form className="settings-card settings-ai-form" onSubmit={event=>{event.preventDefault();if(!loaded||!selected)return;void run(async current=>{
    const value=await window.reader.configureRewrite({...draft,model:draft.model||selected.model});
    if(current()){setDraft(value);setSaved(true);}
  });}}>
    <h2>中文改写</h2>
    <p className="settings-help">在文章中点击“生成中文改写”后，正文会发送到所选 AI 服务，后台生成并仅保存到本机。不会随订阅自动生成，也不会更改 AI 学习的模型。</p>
    <label>改写服务<select value={draft.provider} disabled={!loaded||busy||!providers.length} onChange={event=>{
      const provider=event.target.value as AiProviderId;const next=providers.find(p=>p.id===provider);change({provider,model:next?.model||"",effort:"default"});
    }}>{providers.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
    {selected&&loaded&&<AiModelPicker provider={selected} model={draft.model||selected.model} effort={draft.effort} disabled={busy} onModel={model=>change({model})} onEffort={effort=>change({effort})}/>}
    {selected&&!selected.configured&&<p className="settings-help">请先在上方 AI 服务中完成连接或保存密钥。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="settings-actions">{loaded?<button type="submit" className="primary" disabled={busy||!selected}>{busy?"正在保存…":"保存改写模型"}</button>:<button type="button" disabled={busy} onClick={()=>void load()}>重新读取改写设置</button>}</div>
    {saved&&<p className="settings-help" role="status">改写模型已保存；新任务使用此设置，已排队任务保持原有模型。</p>}
  </form>;
}
