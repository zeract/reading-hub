import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { ReaderArticle } from "../shared/types";

/** Each rendered document owns its image IPC requests, including its cover.
 * A new document invalidates old results immediately; effect cleanup cancels
 * only the old batch, so it cannot cancel images started by a newer render. */
export function useReaderImages(entryId: string, article: ReaderArticle | undefined, container: RefObject<HTMLElement | null>) {
  const document = useMemo(() => ({ id: crypto.randomUUID(), requests: new Map<string, HTMLImageElement>() }), [entryId, article]);
  const { requests } = document;
  const current = useRef(requests);
  current.current = requests;
  useEffect(() => () => {
    for (const requestId of requests.keys()) void window.reader.cancelArticleImage(requestId).catch(() => undefined);
    requests.clear();
  }, [requests]);

  const loadImage = (image: HTMLImageElement, url: string, onFailure: () => void): void => {
    if (!article || !image.isConnected || !container.current?.contains(image)) return;
    const requestId = `image-${crypto.randomUUID()}`;
    requests.set(requestId, image);
    const isCurrent = () => current.current === requests && requests.get(requestId) === image
      && image.isConnected && container.current?.contains(image);
    void window.reader.loadArticleImage(entryId, url, requestId)
      .then((dataUrl) => { if (isCurrent()) image.src = dataUrl; })
      .catch(() => { if (isCurrent()) onFailure(); })
      .finally(() => { requests.delete(requestId); });
  };
  return { documentId: document.id, loadImage };
}
