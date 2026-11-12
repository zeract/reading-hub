import { Worker } from "node:worker_threads";
import path from "node:path";
import { abortError } from "./cancellation";
import type { ReaderConverter, ReaderConversionRequest, ReaderConversionResult } from "./reader-conversion";
import { READER_CONVERSION_ERRORS, ReaderConversionUnavailableError } from "./reader-conversion-errors";

type ConversionOptions = { signal?: AbortSignal; priority?: "foreground" | "background" };
type Task = {
  input: ReaderConversionRequest;
  bytes: number;
  priority: "foreground" | "background";
  signal?: AbortSignal;
  resolve(value: ReaderConversionResult): void;
  reject(error: Error): void;
  cancel(): void;
  flag: Int32Array;
  timer?: ReturnType<typeof setTimeout>;
};

/** One independent CPU worker, bounded admission and foreground-first queue.
 * SQLite has its own worker, so a long formula page cannot delay durable writes. */
export class ReaderConversionClient implements ReaderConverter {
  private readonly queue: Task[] = [];
  private worker?: Worker;
  private active?: Task;
  private stopping?: Promise<void>;
  private closing = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly file = path.join(__dirname, "reader-conversion-worker.js"),
    private readonly taskMs = 120_000,
    private readonly idleMs = 30_000
  ) {}

  convert(input: ReaderConversionRequest, options?: ConversionOptions): Promise<ReaderConversionResult> {
    if (options?.signal?.aborted) return Promise.reject(abortError(options.signal));
    if (this.closing) return Promise.reject(new Error("应用正在退出。"));
    const bytes = Buffer.byteLength(input.html);
    if (bytes > (input.kind === "feed" ? 12_000_000 : 8_000_000)) {
      return Promise.reject(new ReaderConversionUnavailableError("input_limit"));
    }
    if (this.queue.length >= 16 || this.queue.reduce((sum, task) => sum + task.bytes, bytes) > 24_000_000) {
      return Promise.reject(new ReaderConversionUnavailableError("busy"));
    }
    return new Promise((resolve, reject) => {
      const task: Task = {
        input, bytes, priority: options?.priority ?? "foreground", signal: options?.signal,
        resolve, reject, flag: new Int32Array(new SharedArrayBuffer(4)), cancel: () => undefined
      };
      task.cancel = () => {
        Atomics.store(task.flag, 0, 1);
        if (this.active === task) {
          void this.stopWorker(abortError(task.signal!));
        } else {
          const index = this.queue.indexOf(task);
          if (index >= 0) this.queue.splice(index, 1);
          this.finish(task, abortError(task.signal!));
        }
      };
      task.signal?.addEventListener("abort", task.cancel, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }

  private finish(task: Task, error?: Error, value?: ReaderConversionResult): void {
    clearTimeout(task.timer);
    task.signal?.removeEventListener("abort", task.cancel);
    if (error) task.reject(error);
    else task.resolve(value);
  }

  private pump(): void {
    if (this.closing || this.active || this.stopping || !this.queue.length) return;
    clearTimeout(this.idleTimer);
    const index = this.queue.findIndex(task => task.priority === "foreground");
    const task = this.active = this.queue.splice(index < 0 ? 0 : index, 1)[0];
    try {
      if (!this.worker) {
        const worker = this.worker = new Worker(this.file, { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
        worker.on("message", (reply: { value?: ReaderConversionResult; error?: number }) => {
          if (this.worker !== worker || this.stopping || !this.active) return;
          const done = this.active;
          this.active = undefined;
          const fixedError = reply.error === undefined ? undefined : READER_CONVERSION_ERRORS[reply.error];
          const error = reply.error === undefined ? undefined : fixedError
            ? new Error(fixedError) : new ReaderConversionUnavailableError("failed");
          this.finish(done, error, reply.value);
          this.pump();
          if (!this.active && !this.queue.length) {
            this.idleTimer = setTimeout(() => void this.stopWorker(new ReaderConversionUnavailableError("failed")), this.idleMs);
            this.idleTimer.unref();
          }
        });
        worker.on("error", () => {
          if (this.worker === worker) void this.stopWorker(new ReaderConversionUnavailableError("failed"));
        });
        worker.on("exit", () => {
          if (this.worker === worker && !this.stopping) void this.stopWorker(new ReaderConversionUnavailableError("failed"));
        });
      }
      task.timer = setTimeout(() => void this.stopWorker(new ReaderConversionUnavailableError("timeout")), this.taskMs);
      this.worker.postMessage({ input: task.input, cancelled: task.flag.buffer });
    } catch {
      void this.stopWorker(new ReaderConversionUnavailableError("failed"));
    }
  }

  private stopWorker(error: Error): Promise<void> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    const task = this.active;
    if (task) Atomics.store(task.flag, 0, 1);
    this.stopping = (async () => {
      try {
        if (worker) await worker.terminate();
      } finally {
        this.worker = undefined;
        this.active = undefined;
        if (task) this.finish(task, error);
      }
    })().catch(() => {
      for (const queued of this.queue.splice(0)) this.finish(queued, new ReaderConversionUnavailableError("failed"));
    }).finally(() => {
      this.stopping = undefined;
      this.pump();
    });
    return this.stopping;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const task of this.queue.splice(0)) this.finish(task, new Error("应用正在退出。"));
    await this.stopWorker(new Error("应用正在退出。"));
  }
}
