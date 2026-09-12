import { type HTMLAttributes, type Ref } from "react";
import { REWRITE_STAGE_LABELS } from "../shared/rewrite";
import type { useArticleRewrite } from "./use-article-rewrite";
import {ArticleBody} from "./article-body";
type State = ReturnType<typeof useArticleRewrite>;

export function RewriteVersion({state, onSelect}: {state: State; onSelect(visible:boolean):void}) {
  return <div className="reader-version-tabs" role="tablist" aria-label="阅读版本">
    {[false, true].map(visible => <button key={String(visible)} type="button" role="tab" aria-selected={state.visible === visible} tabIndex={state.visible === visible ? 0 : -1}
      onClick={() => onSelect(visible)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? false : event.key === "End" ? true : !visible;
        onSelect(next);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[Number(next)]?.focus();
      }}>{visible ? "中文改写" : "原文"}</button>)}
  </div>;
}

export function RewrittenArticle({state, bodyProps, bodyRef}:{state:State; bodyProps?: HTMLAttributes<HTMLDivElement>;bodyRef?:Ref<HTMLDivElement>}) {
  if (!state.visible) return null;
  const {record, pending, busy, loaded, error} = state;
  const result = record?.result;
  return <article className="reader-article reader-rewritten" aria-label="中文改写">
    <header><h1>{result?.sourceTitle || "中文改写"}</h1></header>
    {!result && <>
      {pending ? <p role="status">{record?.status==="queued"?"已排队":`${record?.stage?REWRITE_STAGE_LABELS[record.stage]:"正在读取正文"}${record?.totalChunks?` · ${record.completedChunks}/${record.totalChunks}`:""}`}<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("cancel")}>取消</button></p> : loaded ? <button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("generate")}>{busy?"正在提交…":"生成中文改写"}</button> : <p role="status">正在读取本地改写…</p>}
      {(error||record?.error)&&<p role="alert">{error||record?.error}{!loaded&&<button type="button" className="action-button" onClick={()=>void state.reload()}>重试读取</button>}</p>}
    </>}
    {result&&<ArticleBody document={result.content} html={result.content?undefined:result.markdown.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!))} bodyRef={bodyRef} {...bodyProps}/>}
  </article>;
}
