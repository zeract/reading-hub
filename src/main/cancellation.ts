/**
 * Small, dependency-free cancellation helpers for main-process work that can
 * cross a network or BrowserWindow boundary.  Callers opt in by passing a
 * signal; existing production requests intentionally retain their current
 * timeout and retry behaviour when no signal is supplied.
 */
export class RequestAbortedError extends Error {
  constructor(message = "操作已取消。") {
    super(message);
    this.name = "RequestAbortedError";
  }
}

export function abortError(signal: AbortSignal, fallbackMessage = "操作已取消。"): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === "string" && signal.reason.trim()) return new RequestAbortedError(signal.reason);
  return new RequestAbortedError(fallbackMessage);
}

export function throwIfAborted(signal?: AbortSignal, fallbackMessage?: string): void {
  if (signal?.aborted) throw abortError(signal, fallbackMessage);
}

/**
 * Combine cancellation sources without depending on AbortSignal.any(), whose
 * availability has differed across the Electron versions we support.
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): { signal?: AbortSignal; dispose(): void } {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!active.length) return { signal: undefined, dispose: () => undefined };

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(abortError(signal));
  };
  for (const signal of active) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      listeners.clear();
    }
  };
}

/** Creates a short-lived request signal while preserving a caller cancellation reason. */
export function withRequestTimeout(parent: AbortSignal | undefined, timeoutMs: number, timeoutMessage: string): {
  signal: AbortSignal;
  dispose(): void;
} {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new RequestAbortedError(timeoutMessage)), timeoutMs);
  const combined = combineAbortSignals(parent, timeout.signal);
  // `timeout.signal` guarantees that a combined signal is always present.
  return {
    signal: combined.signal!,
    dispose: () => {
      clearTimeout(timer);
      combined.dispose();
    }
  };
}

/** Resolves or rejects an async value early when the caller cancels it. */
export function awaitWithAbort<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal!)));
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

/** A cancellation-aware delay for the short post-navigation settle windows. */
export function delayWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
