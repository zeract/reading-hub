import { awaitWithAbort, throwIfAborted } from "./cancellation";

/**
 * FIFO execution per resource key; independent keys can run concurrently.
 * Cancellation ends a queued caller's wait immediately. Once a task starts,
 * it owns its slot until it settles, even if its signal is later aborted.
 * The task itself owns cancellation of its network or other active work.
 */
export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    // A cancelled waiter cannot let successors overtake an active predecessor.
    const tail = previous.then(() => turn);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      await awaitWithAbort(previous, signal);
      throwIfAborted(signal);
      return await task();
    } finally { release(); }
  }
}
