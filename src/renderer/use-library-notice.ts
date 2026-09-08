import { useCallback, useRef, useState } from "react";
import type { Entry } from "../shared/types";

interface NoticeContent {
  message: string;
  undoEntry?: Entry;
}
interface LibraryNotice extends NoticeContent { id: string }

/** Action ownership is independent of its display text. Async completions
 * may update their own notice, but cannot revive or replace a newer one. */
export function useLibraryNotice() {
  const [notice, setNotice] = useState<LibraryNotice>();
  const currentId = useRef<string | undefined>(undefined);
  const revision = useRef(0);
  const show = useCallback((message: string | undefined, undoEntry?: Entry) => {
    const next = message === undefined ? undefined : { id: crypto.randomUUID(), message, undoEntry };
    revision.current += 1;
    currentId.current = next?.id;
    setNotice(next);
  }, []);
  const updateIfCurrent = useCallback((id: string, content: NoticeContent) => {
    if (currentId.current !== id) return;
    revision.current += 1;
    setNotice((current) => current?.id === id ? { id, ...content } : current);
  }, []);
  // Reserve one completion without hiding the current notice. A newer action,
  // notice update or dismissal invalidates it, including within the same render.
  const begin = useCallback(() => {
    const owner = ++revision.current;
    return (message: string, undoEntry?: Entry) => {
      if (revision.current === owner) show(message, undoEntry);
    };
  }, [show]);
  return { notice, show, updateIfCurrent, begin };
}
