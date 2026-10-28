import { session } from "electron";
import { TaskPool } from "./task-pool";
import { awaitWithAbort, withRequestTimeout } from "./cancellation";

const CLEANUP_ERROR = "隔离阅读环境未能安全清理，请重启应用后重试。";
let nextPool = 0;

/** Native BrowserContexts live beyond their windows. Bound their identities,
 * not just BrowserWindow count, and never lend a dirty context to another page. */
export class RenderSessionPool {
  private readonly gate: TaskPool;
  private readonly busy: boolean[];
  private readonly cleaning = new Set<Promise<void>>();
  private readonly prefix = `reader-preview-pool-${++nextPool}`;

  constructor(size = 2, maxQueued = 32) {
    this.gate = new TaskPool(size, maxQueued);
    this.busy = Array(size).fill(false);
  }

  async acquire(signal: AbortSignal) {
    const release = await this.gate.acquire({ signal });
    const index = this.busy.indexOf(false);
    this.busy[index] = true;
    let isolated: Electron.Session;
    try {
      isolated = session.fromPartition(`${this.prefix}-${index}`, { cache: false });
    } catch (error) {
      this.busy[index] = false;
      release();
      throw error;
    }
    let cleanup: Promise<void> | undefined;
    const clean = () => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        const timeout = withRequestTimeout(undefined, 5000, CLEANUP_ERROR);
        try {
          await awaitWithAbort(Promise.all([
            isolated.clearStorageData(), isolated.clearCache(),
            isolated.clearAuthCache(), isolated.closeAllConnections()
          ]), timeout.signal);
          this.busy[index] = false;
        } catch {
          // Never compensate for failed cleanup by allocating fresh identities.
          this.gate.close(new Error(CLEANUP_ERROR));
          throw new Error(CLEANUP_ERROR);
        } finally {
          timeout.dispose();
          release();
        }
      })();
      this.cleaning.add(cleanup);
      void cleanup.finally(() => this.cleaning.delete(cleanup!)).catch(() => undefined);
      return cleanup;
    };
    return { session: isolated, release: clean };
  }

  /** Owners cancel/drain renders first; also drain cleanup detached by a failed
   * render so explicit quit does not abandon native storage operations. */
  async close(): Promise<void> {
    this.gate.close(new Error("应用正在退出。"));
    await Promise.allSettled(this.cleaning);
  }
}
export const publicRenderSessions = new RenderSessionPool();
