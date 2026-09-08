import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry } from "../shared/types";
import { errorMessage } from "./errors";

export type EntryMutationField = "read" | "favorite";
export type EntryMutationPending = (entryId: string, field: EntryMutationField) => boolean;
type PendingMutation = { value: boolean; result: Promise<boolean> };

/** One command owner for the list, reader toolbar, and automatic read marker.
 * Equal pending intents share a result; opposite intents run in arrival order.
 * Other articles and fields remain independent. Accepted writes survive unmount.
 */
export function useEntryMutations({ onCommitted, reload, onError }: {
  onCommitted: (entryId: string, field: EntryMutationField, value: boolean) => void;
  reload: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const pending = useRef(new Map<string, PendingMutation>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setPendingKeys(new Set(pending.current.keys()));
    return () => { mounted.current = false; };
  }, []);

  const updateEntry = useCallback((entry: Entry, field: EntryMutationField, value: boolean): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false);
    const key = `${field}:${entry.id}`;
    const previous = pending.current.get(key);
    if (previous?.value === value) return previous.result;

    // Install the command before starting IPC, so calls in the same event or
    // StrictMode effect replay observe the same pending intent.
    const result = (previous?.result ?? Promise.resolve()).then(async () => {
      try {
        if (field === "read") await window.reader.markRead(entry.id, value);
        else await window.reader.markFavorite(entry.id, value);
      } catch (error) {
        if (mounted.current) onError(errorMessage(error));
        return false;
      }
      if (mounted.current) {
        onCommitted(entry.id, field, value);
        // A read-model failure has its own error/retry UI. It must not turn
        // a committed write into a failed mutation or cause it to be repeated.
        await reload().catch(() => undefined);
      }
      return true;
    }).finally(() => {
      if (pending.current.get(key)?.result !== result) return;
      pending.current.delete(key);
      if (mounted.current) setPendingKeys(new Set(pending.current.keys()));
    });
    pending.current.set(key, { value, result });
    setPendingKeys(new Set(pending.current.keys()));
    return result;
  }, [onCommitted, onError, reload]);

  const isEntryUpdating: EntryMutationPending = useCallback((entryId, field) => pendingKeys.has(`${field}:${entryId}`), [pendingKeys]);
  return { updateEntry, isEntryUpdating };
}
