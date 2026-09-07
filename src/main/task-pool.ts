import { abortError, throwIfAborted } from "./cancellation";

export class TaskPoolFullError extends Error {
  constructor() {
    super("等待中的请求过多，请稍后重试。");
    this.name = "TaskPoolFullError";
  }
}

/** FIFO admission with bounded active and waiting work. Cancellation removes
 * queued work immediately. Active operations own their slot until they settle,
 * including cleanup; they must enforce their own deadlines and cancellation.
 * Omitting maxQueued preserves an unbounded waiting queue.
 * Explicit leases support work whose cleanup outlives the caller's response. */
export class TaskPool {
  private active = 0;
  private readonly waiting = new Set<{ start(): void; reject(error: Error): void }>();
  private closedError?: Error;

  constructor(private readonly concurrency: number, private readonly maxQueued?: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1
      || (maxQueued !== undefined && (!Number.isSafeInteger(maxQueued) || maxQueued < 0))) {
      throw new RangeError("Task pool limits must be safe integers with positive concurrency and nonnegative queue capacity.");
    }
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.waiting.size; }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire({ signal });
    try {
      throwIfAborted(signal);
      return await operation();
    } finally { release(); }
  }

  acquire({ signal, abortError: cancelled }: { signal?: AbortSignal; abortError?: () => Error } = {}): Promise<() => void> {
    if (this.closedError) return Promise.reject(this.closedError);
    const cancellation = () => cancelled?.() ?? abortError(signal!);
    if (signal?.aborted) return Promise.reject(cancellation());
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaseSlot());
    }
    if (this.maxQueued !== undefined && this.waiting.size >= this.maxQueued) return Promise.reject(new TaskPoolFullError());
    return new Promise((resolve, reject) => {
      const waiter = {
        start: () => {
          signal?.removeEventListener("abort", cancel);
          this.active++;
          resolve(this.releaseSlot());
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", cancel);
          reject(error);
        }
      };
      const cancel = () => {
        if (!this.waiting.delete(waiter)) return;
        waiter.reject(cancellation());
      };
      this.waiting.add(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  /** Reject queued and future work, but let active owners finish cleanup. */
  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiting) waiter.reject(error);
    this.waiting.clear();
  }

  private releaseSlot(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      // Reserve the next slot synchronously so a new arrival cannot overtake
      // an older waiter while its Promise continuation is still pending.
      const next = this.waiting.values().next().value;
      if (next) {
        this.waiting.delete(next);
        next.start();
      }
    };
  }
}
