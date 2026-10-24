import { observeReaderImage, replaceReaderImageFailure } from "./reader-image-loader";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { ReaderArticle } from "../shared/types";

/** Each rendered document owns its image IPC requests, including its cover.
 * A new document invalidates old results immediately; effect cleanup cancels
 * only the old batch, so it cannot cancel images started by a newer render. */
export function useReaderImages(entryId: string, article: ReaderArticle | undefined, container: RefObject<HTMLElement | null>) {
  const document = useMemo(() => ({ id: crypto.randomUUID(), requests: new Map<HTMLImageElement, () => void>() }), [entryId, article]);
  const { requests } = document;
  const current = useRef(requests);
  current.current = requests;
  useEffect(() => () => {
    for (const cancel of requests.values()) cancel();
    requests.clear();
  }, [requests]);

  const loadImage = (image: HTMLImageElement, url: string, onFailure: () => void): void => {
    if (!article || !image.isConnected || !container.current?.contains(image)) return;
    requests.get(image)?.();
    const isCurrent = () => current.current === requests && image.isConnected && container.current?.contains(image);
    requests.set(image, observeReaderImage(image,entryId,url,
      dataUrl=>{if(isCurrent())image.src=dataUrl;},
      code=>{if(isCurrent()){image.dataset.imageFailure=code;onFailure();}}));
  };
  useEffect(() => {
    if (!article) return;
    for (const image of container.current?.querySelectorAll<HTMLImageElement>("img[data-reader-image-url]") ?? []) {
      const url = image.dataset.readerImageUrl;
      if (!url) continue;
      image.dataset.readerProxyTried = "1";
      loadImage(image, url, () => replaceReaderImageFailure(image, article.url, image.dataset.imageFailure));
    }
  }, [document, article, entryId, container]);
  return { documentId: document.id, loadImage };
}
