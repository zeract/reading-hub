import { Worker } from "node:worker_threads";
import path from "node:path";
import type { ArticleStore } from "./persistence/article-store";
import { ArticlePersistenceContentError } from "./persistence/article-store";
import type { DataLocationResolverOptions, DataLocationResolution } from "./data-location-migration";

type StoreMethod = keyof ArticleStore;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
const STORAGE_ERROR = "本地存储工作线程未能完成操作，已保留数据，请重新启动应用后重试。";

/** Host-only RPC. The worker owns its connection and serializes accepted work.
 * No SQL, credentials, or remote code can cross this boundary. */
export class StorageWorkerClient {
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closing = false;
  private failure?: Error;
  private closePromise?: Promise<void>;
  private exited = Promise.resolve();
  constructor(private readonly databasePath?: string, private readonly workerFile = path.join(__dirname, "storage-worker.js")) {}
  private connect(): void {
    if (this.worker) return;
    const worker = this.worker = new Worker(this.workerFile, { workerData: { databasePath: this.databasePath } });
    worker.on("message", (reply: { id: number; value?: unknown; error?: "content" | "storage"; message?: string }) => {
      const task = this.pending.get(reply.id);
      if (!task) return;
      this.pending.delete(reply.id);
      if (reply.error) task.reject(reply.error === "content"
        ? new ArticlePersistenceContentError(reply.message) : new Error(STORAGE_ERROR));
      else task.resolve(reply.value);
    });
    worker.on("error", () => this.fail());
    this.exited = new Promise(resolve => worker.once("exit", code => {
      if (!this.closing || code !== 0 || this.pending.size) this.fail();
      resolve();
    }));
  }
  call<K extends StoreMethod>(method: K, ...args: Parameters<ArticleStore[K]>): Promise<ReturnType<ArticleStore[K]>> {
    return this.send(method, args) as Promise<ReturnType<ArticleStore[K]>>;
  }
  prepare(options: Omit<DataLocationResolverOptions, "now">): Promise<DataLocationResolution> {
    return this.send("prepare", [options]) as Promise<DataLocationResolution>;
  }
  private send(method: string, args: unknown[], closing = false): Promise<unknown> {
    if (this.failure || this.closing && !closing) return Promise.reject(this.failure ?? new Error(STORAGE_ERROR));
    // Downloads already have bounded concurrency; also bound host admission.
    if (!closing && this.pending.size >= 64) return Promise.reject(new Error("本地保存任务繁忙，请稍后重试。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      try {
        this.connect();
        this.pending.set(id, { resolve, reject });
        this.worker!.postMessage({ id, method, args });
      }
      catch { this.pending.delete(id); reject(new Error(STORAGE_ERROR)); }
    });
  }
  private fail(): void {
    this.failure ??= new Error(STORAGE_ERROR);
    for (const task of this.pending.values()) task.reject(this.failure);
    this.pending.clear();
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (async () => {
        try { if (this.worker && !this.failure) await this.send("close", [], true); }
        finally { await this.exited; }
        if (this.failure) throw this.failure;
      })();
    }
    return this.closePromise;
  }
}

/** Keep all full safety checks and upgrade backups, outside Electron's loop. */
export async function prepareStartupLibrary(options: Omit<DataLocationResolverOptions, "now">): Promise<DataLocationResolution> {
  const worker = new StorageWorkerClient();
  try { return await worker.prepare(options); }
  finally { await worker.close(); }
}
