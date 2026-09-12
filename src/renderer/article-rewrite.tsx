import { REWRITE_STAGE_LABELS } from "../shared/rewrite";
import type { useArticleRewrite } from "./use-article-rewrite";
import { DeferredAiMarkdownContent } from "./deferred-ai-markdown";
type State = ReturnType<typeof useArticleRewrite>;

export function RewriteVersion({state, onSelect}: {state: State; onSelect(visible:boolean):void}) {
  return <select className="reader-version-select" aria-label="阅读版本" value={state.visible?"rewrite":"original"} onChange={event=>onSelect(event.target.value==="rewrite")}>
    <option value="original">原文</option><option value="rewrite">中文改写</option>
  </select>;
}

export function RewrittenArticle({state}:{state:State}) {
  if (!state.visible) return null;
  const {record, pending, busy, loaded, error} = state;
  const result = record?.result;
  return <article className="reader-article reader-rewritten" aria-label="中文改写">
    <header><h1>{result?.sourceTitle || "中文改写"}</h1></header>
    {!result && <>
      {pending ? <p role="status">{record?.status==="queued"?"已排队":`${record?.stage?REWRITE_STAGE_LABELS[record.stage]:"正在读取正文"}${record?.totalChunks?` · ${record.completedChunks}/${record.totalChunks}`:""}`}<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("cancel")}>取消</button></p> : loaded ? <button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("generate")}>{busy?"正在提交…":"生成中文改写"}</button> : <p role="status">正在读取本地改写…</p>}
      {(error||record?.error)&&<p role="alert">{error||record?.error}{!loaded&&<button type="button" className="action-button" onClick={()=>void state.reload()}>重试读取</button>}</p>}
    </>}
    {result&&<div className="article-body"><DeferredAiMarkdownContent text={result.markdown} entryId={record.entryId}/></div>}
  </article>;
}
