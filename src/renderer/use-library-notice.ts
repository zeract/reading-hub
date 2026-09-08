import { useCallback, useState } from "react";
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
  const show = useCallback((message: string | undefined, undoEntry?: Entry) => {
    setNotice(message === undefined ? undefined : { id: crypto.randomUUID(), message, undoEntry });
  }, []);
  const updateIfCurrent = useCallback((id: string, content: NoticeContent) => {
    setNotice((current) => current?.id === id ? { id, ...content } : current);
  }, []);
  return { notice, show, updateIfCurrent };
}
