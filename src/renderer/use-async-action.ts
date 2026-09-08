import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./errors";
import { LatestRequestGuard } from "./request-guard";

/** One view-owned action at a time. Invalidation ignores results; it does not
 * cancel IPC or undo writes. Tasks must check isCurrent before publishing
 * view-specific results or starting optional follow-up requests. */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const requests = useRef(new LatestRequestGuard());
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      running.current = false;
      requests.current.invalidate();
    };
  }, []);

  const clearError = useCallback(() => { if (mounted.current) setError(undefined); }, []);
  const fail = useCallback((reason: unknown) => { if (mounted.current) setError(errorMessage(reason)); }, []);
  const isRunning = useCallback(() => running.current, []);
  const invalidate = useCallback(() => {
    requests.current.invalidate();
    running.current = false;
    if (mounted.current) { setBusy(false); setError(undefined); }
  }, []);

  const run = useCallback(async (task: (isCurrent: () => boolean) => void | Promise<void>) => {
    if (!mounted.current || running.current) return;
    running.current = true;
    const revision = requests.current.begin();
    const isCurrent = () => mounted.current && requests.current.isCurrent(revision);
    setBusy(true); setError(undefined);
    try { await task(isCurrent); }
    catch (reason) { if (isCurrent()) setError(errorMessage(reason)); }
    finally {
      if (isCurrent()) { running.current = false; setBusy(false); }
    }
  }, []);

  return { busy, error, run, invalidate, clearError, fail, isRunning };
}
