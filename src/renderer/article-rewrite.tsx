import { REWRITE_STAGE_LABELS } from "../shared/rewrite";
import type { useArticleRewrite } from "./use-article-rewrite";
import { DeferredAiMarkdownContent } from "./deferred-ai-markdown";
type State=ReturnType<typeof useArticleRewrite>;
export function RewriteControls({ state, onToggle }: { state:State; onToggle():void }) {
  const {record,pending,busy,error,loaded}=state;
  return <div className="reader-rewrite-controls">
    <div className="reader-rewrite-actions">
      {record?.result&&<button type="button" className="action-button" aria-pressed={state.visible} onClick={onToggle}>{state.visible?"查看原文":"查看中文改写"}</button>}
      {pending?<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("cancel")}>取消改写</button>:<button type="button" className="action-button" disabled={busy||!loaded} onClick={()=>void state.act("generate")}>{busy?"正在提交…":record?.result?"重新生成改写":"生成中文改写"}</button>}
      {record?.result&&!pending&&<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("remove")}>删除改写</button>}
    </div>
    {pending&&<p role="status">{record?.status==="queued"?"已排队，可继续阅读其他文章。":record?.totalChunks?`${record.stage ? REWRITE_STAGE_LABELS[record.stage] : "正在处理"} · ${record.completedChunks}/${record.totalChunks} 步，可继续阅读其他文章。`:"正在读取正文，准备改写…"}</p>}
    {record?.status==="cancelled"&&<p role="status">改写已取消。</p>}
    {(error||record?.error)&&<p role="alert">{error||record?.error}{!loaded&&<button type="button" className="action-button" onClick={()=>void state.reload()}>重试读取</button>}</p>}
  </div>;
}
export function RewrittenArticle({state}:{state:State}) {
  const result=state.record?.result;if(!state.visible||!result)return null;
  return <article className="reader-article reader-rewritten" aria-label="中文改写">
    <header><p className="eyebrow">AI 中文改写 · 本地保存</p><h1>{result.sourceTitle}</h1><p className="reader-byline">{result.model} · {new Date(result.createdAt).toLocaleString()}</p></header>
    <aside className="reader-content-notice">基于生成时的原文改写，可能存在理解偏差，请以原文为准。重新生成成功后才会替换此稿。</aside>
    {result.quality && <p className="reader-byline" role="note">已完成 {result.quality.reviewedSections} 节、{result.quality.reviewedBlocks} 段的模型对照检查；这不代表事实准确性的保证。</p>}
    <div className="article-body"><DeferredAiMarkdownContent text={result.markdown}/></div>
  </article>;
}
