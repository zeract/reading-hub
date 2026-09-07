import { abortError, throwIfAborted } from "./cancellation";

export class TaskPoolFullError extends Error {
  constructor() {
    super("等待中的请求过多，请稍后重试。");
    this.name = "TaskPoolFullError";
  }
}

/** FIFO admission with bounded active and waiting work. Cancellation removes
 * queued work immediately. Active operations own their slot until they settle,
 * including cleanup; they must enforce their own deadlines and cancellation. */
export class TaskPool {
  private active = 0;
  private readonly waiting = new Set<() => void>();

  constructor(private readonly concurrency: number, private readonly maxQueued: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1
      || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError("Task pool limits must be safe integers with positive concurrency and nonnegative queue capacity.");
    }
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await operation();
    } finally { release(); }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaseSlot());
    }
    if (this.waiting.size >= this.maxQueued) throw new TaskPoolFullError();
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        this.active++;
        resolve(this.releaseSlot());
      };
      const cancel = () => {
        this.waiting.delete(start);
        signal?.removeEventListener("abort", cancel);
        reject(abortError(signal!));
      };
      this.waiting.add(start);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
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
        next();
      }
    };
  }
}
