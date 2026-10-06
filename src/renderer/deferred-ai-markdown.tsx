import { memo, useEffect, useSyncExternalStore } from "react";
import { aiMarkdownResource } from "./ai-markdown-resource";

/** Message state and streaming remain owned by the caller while code loads. */
export const DeferredAiMarkdownContent = memo(function DeferredAiMarkdownContent({ text, entryId, sourceUrl, showRecovery = true }: { text: string; entryId?: string; sourceUrl?: string; showRecovery?: boolean }) {
  const state = useSyncExternalStore(aiMarkdownResource.subscribe, aiMarkdownResource.getSnapshot);
  useEffect(() => {
    if (state.status === "idle") aiMarkdownResource.load();
  }, [state.status]);
  if (state.status === "ready") return <state.Renderer text={text} entryId={entryId} sourceUrl={sourceUrl} />;
  return <div className="ai-markdown-fallback">
    <div className="ai-message-content ai-message-content--plain">{text}</div>
    {showRecovery && (state.status === "error"
      ? <div className="ai-markdown-load-error" role="alert">
        <p>格式化显示暂不可用，内容已保留。</p>
        <button type="button" className="action-button" onClick={aiMarkdownResource.load}>重试显示</button>
      </div>
      : <p className="ai-markdown-loading" role="status">正在准备格式化显示…</p>)}
  </div>;
});
