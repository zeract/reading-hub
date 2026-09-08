import { useCallback, useEffect, useRef, useState } from "react";

/** Reports overlapping shell activity without serializing or cancelling it.
 * Callers still own admission, errors, and mutation completion. */
export function useAsyncActivity() {
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Set<symbol>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setBusy(pending.current.size > 0);
    return () => { mounted.current = false; };
  }, []);

  const track = useCallback(async <T,>(operation: () => T | Promise<T>): Promise<T> => {
    const token = Symbol();
    pending.current.add(token);
    if (mounted.current) setBusy(true);
    try { return await operation(); }
    finally {
      pending.current.delete(token);
      if (mounted.current) setBusy(pending.current.size > 0);
    }
  }, []);

  return { busy, track };
}
