import { useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import { AppIcon } from "./ui-icons";
import { REWRITE_STAGE_LABELS } from "../shared/rewrite";
import type { useArticleRewrite } from "./use-article-rewrite";
import { DeferredAiMarkdownContent } from "./deferred-ai-markdown";
type State = ReturnType<typeof useArticleRewrite>;

export function RewriteVersion({state, onSelect}: {state: State; onSelect(visible:boolean):void}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const choose = (visible: boolean) => { onSelect(visible); setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <div className="reader-version" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const options = [...root.current!.querySelectorAll<HTMLElement>('[role="option"]')];
      const index = options.indexOf(document.activeElement as HTMLElement);
      options[event.key === "Home" ? 0 : event.key === "End" ? 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + 2) % 2]?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="reader-version-select" aria-label="阅读版本" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {state.visible ? "中文改写" : "原文"}<AppIcon name="chevron-down"/>
    </button>
    {open && <div id={id} className="reader-version-menu" role="listbox" aria-label="阅读版本">
      {[false, true].map(visible => <button key={String(visible)} type="button" role="option" aria-selected={state.visible === visible} tabIndex={-1} onClick={() => choose(visible)}>{visible ? "中文改写" : "原文"}</button>)}
    </div>}
  </div>;
}

export function RewrittenArticle({state, bodyProps}:{state:State; bodyProps?: HTMLAttributes<HTMLDivElement>}) {
  if (!state.visible) return null;
  const {record, pending, busy, loaded, error} = state;
  const result = record?.result;
  return <article className="reader-article reader-rewritten" aria-label="中文改写">
    <header><h1>{result?.sourceTitle || "中文改写"}</h1></header>
    {!result && <>
      {pending ? <p role="status">{record?.status==="queued"?"已排队":`${record?.stage?REWRITE_STAGE_LABELS[record.stage]:"正在读取正文"}${record?.totalChunks?` · ${record.completedChunks}/${record.totalChunks}`:""}`}<button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("cancel")}>取消</button></p> : loaded ? <button type="button" className="action-button" disabled={busy} onClick={()=>void state.act("generate")}>{busy?"正在提交…":"生成中文改写"}</button> : <p role="status">正在读取本地改写…</p>}
      {(error||record?.error)&&<p role="alert">{error||record?.error}{!loaded&&<button type="button" className="action-button" onClick={()=>void state.reload()}>重试读取</button>}</p>}
    </>}
    {result&&<div className="article-body" {...bodyProps}><DeferredAiMarkdownContent text={result.markdown} entryId={record.entryId}/></div>}
  </article>;
}
