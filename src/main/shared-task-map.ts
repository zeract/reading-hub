import { awaitWithAbort, throwIfAborted } from "./cancellation";

type SharedTask<T> = { controller: AbortController; promise: Promise<T>; waiters: number; finished: boolean };

/** Coalesce equivalent reads, unlike KeyedTaskQueue which serializes distinct
 * writes. Each key must identify the full request context and result. The first
 * loader owns network cleanup/deadlines; it must honor the shared signal before
 * publishing side effects such as cache writes. Results are not retained here. */
export class SharedTaskMap<T> {
  private readonly pending = new Map<string, SharedTask<T>>();

  async run(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    let task = this.pending.get(key);
    if (!task) {
      const controller = new AbortController();
      const created: SharedTask<T> = {
        controller, waiters: 0, finished: false,
        // Register the task and its first waiter before starting work.
        promise: Promise.resolve().then(() => {
          throwIfAborted(controller.signal);
          return load(controller.signal);
        }).then((value) => {
          throwIfAborted(controller.signal);
          return value;
        }).finally(() => {
          created.finished = true;
          if (this.pending.get(key) === created) this.pending.delete(key);
        })
      };
      task = created;
      this.pending.set(key, task);
    }
    task.waiters++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      task.waiters--;
      if (!task.waiters && !task.finished) {
        if (this.pending.get(key) === task) this.pending.delete(key);
        task.controller.abort();
      }
    };
    // Last-waiter cancellation invalidates this task synchronously; late
    // cleanup cannot remove a replacement or publish an abandoned result.
    signal?.addEventListener("abort", release, { once: true });
    if (signal?.aborted) release();
    try {
      const result = await awaitWithAbort(task.promise, signal);
      throwIfAborted(signal);
      return result;
    } finally { release(); }
  }
}
