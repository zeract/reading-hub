import { useCallback, useEffect, useMemo, useRef } from "react";
import { LatestRequestGuard } from "./request-guard";

/** One latest extraction per reader entry, with both cooperative IPC
 * cancellation and a result guard for work that settles after cancellation. */
export function useReaderRequest(entryId: string) {
  const batch = useMemo(() => ({ guard: new LatestRequestGuard(), activeId: undefined as string | undefined }), [entryId]);
  const current = useRef(batch);
  current.current = batch;
  const cancelActive = useCallback(() => {
    const id = batch.activeId;
    batch.activeId = undefined;
    if (id) void window.reader.cancelEntryRead(id).catch(() => undefined);
  }, [batch]);
  useEffect(() => () => { batch.guard.invalidate(); cancelActive(); }, [batch, cancelActive]);

  return useCallback(() => {
    const revision = batch.guard.begin();
    cancelActive();
    const id = `read-${crypto.randomUUID()}`;
    batch.activeId = id;
    return {
      id,
      isCurrent: () => current.current === batch && batch.guard.isCurrent(revision),
      finish: () => { if (batch.activeId === id) batch.activeId = undefined; }
    };
  }, [batch, cancelActive]);
}
