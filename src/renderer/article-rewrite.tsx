import { REWRITE_STAGE_LABELS } from "../shared/rewrite";
import type { useArticleRewrite } from "./use-article-rewrite";
import { DeferredAiMarkdownContent } from "./deferred-ai-markdown";
type State=ReturnType<typeof useArticleRewrite>;
export function RewriteControls({ state, onSelect }: { state:State; onSelect(visible:boolean):void }) {
  const {record,pending,busy,error,loaded}=state;
  return <div className="reader-rewrite-controls">
    <div className="reader-rewrite-actions">
      <div className="reader-version-switch" role="group" aria-label="阅读版本">
        <button type="button" className="action-button" aria-pressed={!state.visible} onClick={()=>onSelect(false)}>原文</button>
        <button type="button" className="action-button" aria-pressed={state.visible} onClick={()=>onSelect(true)}>中文改写</button>
      </div>
      {state.visible && (pending?<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("cancel")}>{record?.kind==="review"?"取消检查":"取消改写"}</button>:<button type="button" className="action-button" disabled={busy||!loaded} onClick={()=>void state.act("generate")}>{busy?"正在提交…":record?.result?"重新生成改写":"生成中文改写"}</button>)}
      {state.visible&&record?.result&&!pending&&<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("remove")}>删除改写</button>}
      {state.visible&&record?.result?.sections&&!pending&&<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("review")}>检查改写</button>}
    </div>
    {pending&&<p role="status">{record?.status==="queued"?"已排队，可继续阅读其他文章。":record?.totalChunks?`${record.stage ? REWRITE_STAGE_LABELS[record.stage] : "正在处理"} · ${record.completedChunks}/${record.totalChunks} 步，可继续阅读其他文章。`:record?.kind==="review"?"正在读取原文，准备检查；中文仍可阅读。":"正在读取正文，准备改写…"}</p>}
    {record?.status==="cancelled"&&<p role="status">任务已取消。</p>}
    {(error||record?.error)&&<p role="alert">{error||record?.error}{!loaded&&<button type="button" className="action-button" onClick={()=>void state.reload()}>重试读取</button>}</p>}
  </div>;
}
export function RewrittenArticle({state}:{state:State}) {
  if(!state.visible)return null;
  const result=state.record?.result;
  if(!result)return <article className="reader-article reader-rewritten" aria-label="中文改写"><h1>中文改写</h1><p>{state.pending?"正在后台生成，完成后会在这里显示。":state.loaded?"尚未生成中文改写。点击上方“生成中文改写”后开始，结果保存到本地。":"正在读取本地改写…"}</p></article>;
  return <article className="reader-article reader-rewritten" aria-label="中文改写">
    <header><p className="eyebrow">AI 中文改写 · 本地保存</p><h1>{result.sourceTitle}</h1><p className="reader-byline">{result.model} · {new Date(result.createdAt).toLocaleString()}</p></header>
    <p className="reader-byline" role="note">AI 改写可能存在理解偏差，请以原文为准。重新生成期间可继续阅读此稿。</p>
    {Boolean(result.quality?.reviewedSections) && <p className="reader-byline" role="note">已完成 {result.quality!.reviewedSections} 节、{result.quality!.reviewedBlocks} 段的模型对照检查；这不代表事实准确性的保证。</p>}
    {!result.review&&!result.quality?.reviewedSections&&<p className="reader-byline" role="note">未进行额外模型检查。可按需点击“检查改写”，会另行调用模型。</p>}
    {result.review&&<aside className="reader-content-notice" role="note">
      <p>{result.review.issues.length ? `有 ${result.review.issues.length} 项模型建议待核对，中文仍可正常阅读。` : "模型对照检查未报告问题，不代表事实准确性的保证。"}</p>
      {result.review.issues.length>0&&<details><summary>查看待核对项</summary><ul>{result.review.issues.map((issue,i)=><li key={i}><strong>第 {issue.sectionId.slice(1)} 节 · {issue.kind==="cohesion"?"衔接建议":"内容待核对"}</strong><p>{issue.message}</p>{issue.sourceQuote&&<blockquote>{issue.sourceQuote}</blockquote>}</li>)}</ul></details>}
    </aside>}
    <div className="article-body"><DeferredAiMarkdownContent text={result.markdown}/></div>
  </article>;
}
