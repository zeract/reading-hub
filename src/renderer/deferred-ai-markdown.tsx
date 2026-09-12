import { memo, useEffect, useSyncExternalStore } from "react";
import { aiMarkdownResource } from "./ai-markdown-resource";

/** Message state and streaming remain owned by the caller while code loads. */
export const DeferredAiMarkdownContent = memo(function DeferredAiMarkdownContent({ text, entryId, sourceUrl }: { text: string; entryId?: string; sourceUrl?: string }) {
  const state = useSyncExternalStore(aiMarkdownResource.subscribe, aiMarkdownResource.getSnapshot);
  useEffect(() => {
    if (state.status === "idle") aiMarkdownResource.load();
  }, [state.status]);
  if (state.status === "ready") return <state.Renderer text={text} entryId={entryId} sourceUrl={sourceUrl} />;
  if (state.status === "error") return <div className="ai-markdown-load-error" role="alert">
    <p>回答显示组件暂时无法加载。</p>
    <button type="button" onClick={aiMarkdownResource.load}>重试显示回答</button>
  </div>;
  return <p className="ai-streaming-status" role="status">正在准备回答显示…</p>;
});
