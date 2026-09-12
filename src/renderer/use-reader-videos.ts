import { useEffect, type RefObject } from "react";
import type { ReaderArticle } from "../shared/types";

/** One ephemeral clip per document. Fetch and playback never use origin code. */
export function useReaderVideos(entryId: string, article: ReaderArticle | undefined, container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root || !article) return;
    let current: { video: HTMLVideoElement; button: HTMLButtonElement; requestId: string; blob?: string } | undefined;
    const reset = () => {
      const previous = current;
      current = undefined;
      if (!previous) return;
      void window.reader.cancelArticleVideo(previous.requestId).catch(() => undefined);
      previous.video.pause(); previous.video.removeAttribute("src"); previous.video.load();
      if (previous.blob) URL.revokeObjectURL(previous.blob);
      previous.button.disabled = false; previous.button.hidden = false;
      previous.button.textContent = "加载视频";
      const status = previous.button.parentElement?.querySelector("[role=status]");
      if (status) status.textContent = "";
    };
    const click = async (event: Event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-reader-video-load]") : null;
      if (!button || !root.contains(button) || button.disabled) return;
      const video = button.parentElement?.querySelector("video");
      const status = button.parentElement?.querySelector("[role=status]");
      if (!video || !status) return;
      event.preventDefault();
      reset();
      const task = { video, button, requestId: `video-${crypto.randomUUID()}`, blob: undefined as string | undefined };
      current = task; button.disabled = true; button.textContent = "正在加载…"; status.textContent = "";
      try {
        const sources: string[] = JSON.parse(video.dataset.readerVideoSources || "[]");
        for (const source of sources) {
          try {
            const data = await window.reader.loadArticleVideo(entryId, source, task.requestId);
            if (current !== task) return;
            if (!video.canPlayType(data.contentType)) throw new Error("unsupported");
            task.blob = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.contentType }));
            video.src = task.blob; video.load();
            button.hidden = true;
            // Load is user-initiated; explicit native controls start playback.
            status.textContent = "已加载，请点击播放。";
            return;
          } catch { if (current !== task) return; }
        }
        throw new Error("unavailable");
      } catch {
        if (current === task) { reset(); status.textContent = "视频无法加载、格式不支持或超过 32 MB，请重试或在原文中观看。"; }
      }
    };
    const fail = (event: Event) => {
      if (!current || event.target !== current.video || !current.video.hasAttribute("src")) return;
      const status = current.button.parentElement?.querySelector("[role=status]");
      reset(); if (status) status.textContent = "视频无法播放，请在原文中观看。";
    };
    root.addEventListener("click", click); root.addEventListener("error", fail, true);
    return () => { root.removeEventListener("click", click); root.removeEventListener("error", fail, true); reset(); };
  }, [entryId, article, container]);
}
