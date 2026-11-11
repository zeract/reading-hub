import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskPool } from "./task-pool";
import { abortError, throwIfAborted, withRequestTimeout } from "./cancellation";
import { assertPublicUrl } from "../shared/url";
import { RobotsPolicy } from "./robots";
import type { PageRenderer, PageRenderOptions, RenderedPage } from "./page-renderer";
import { decodeRenderError, RENDER_FAILURE, RENDER_TIMEOUT, workerEnvironment, type WorkerError } from "./render-worker-protocol";

export type RenderWorkerLauncher = (profile: string) => ChildProcess;
function launchWorker(profile: string): ChildProcess {
  // In development the executable needs the application entry path. Packaged
  // Electron dispatches our main entry directly. Neither route loads user data.
  const args = app.isPackaged ? [] : [path.join(__dirname, "index.js")];
  return spawn(process.execPath, [...args, "--reader-render-worker"], {
    env: workerEnvironment(profile), stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
}

/** Native Session cleanup has no cancellation API. A bounded, disposable
 * process is the isolation boundary; a slot lives until that process exits,
 * independently of when its captured document is delivered to the caller. */
export class RenderWorkerPool {
  private readonly gate = new TaskPool(2, 32);
  private readonly jobs = new Set<{ cancel(): void; done: Promise<void> }>();
  private closing = false;
  private readonly operations = new Set<Promise<RenderedPage>>();
  constructor(private readonly launch: RenderWorkerLauncher = launchWorker,
    private readonly cleanupMs = 7_000, private readonly taskMs = 30_000) {}

  render(robots: RobotsPolicy, rawUrl: string, options?: PageRenderOptions): Promise<RenderedPage> {
    const operation = this.run(robots, rawUrl, options);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async run(robots: RobotsPolicy, rawUrl: string, options?: PageRenderOptions): Promise<RenderedPage> {
    const url = assertPublicUrl(rawUrl).toString();
    const maxBytes = Math.min(options?.maxBytes ?? 8_000_000, 8_000_000);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("页面大小限制无效。");
    const request = withRequestTimeout(options?.signal, this.taskMs, RENDER_TIMEOUT);
    let release: (() => void) | undefined;
    let profile: string | undefined;
    try {
      release = await this.gate.acquire({ signal: request.signal });
      throwIfAborted(request.signal);
      profile = await mkdtemp(path.join(tmpdir(), "reading-hub-render-"));
      throwIfAborted(request.signal);
      if (this.closing) throw new Error("应用正在退出。");
      const child = this.launch(profile);
      // Ownership passes to the child-close handler before returning a result.
      const ownedRelease = release; release = undefined;
      const ownedProfile = profile; profile = undefined;
      return await new Promise<RenderedPage>((resolve, reject) => {
        let settled = false;
        let policyError: unknown;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        let finish!: () => void;
        const done = new Promise<void>(r => { finish = r; });
        const settle = (error?: unknown, page?: RenderedPage) => {
          if (settled) return;
          settled = true;
          request.signal.removeEventListener("abort", cancel);
          request.dispose();
          if (error) reject(error); else resolve(page!);
        };
        const kill = () => {
          if (closed || killTimer) return;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 1_000);
        };
        const cancel = () => { settle(abortError(request.signal)); kill(); };
        const job = { cancel: () => { settle(new Error("应用正在退出。")); kill(); }, done };
        this.jobs.add(job);
        const send = (message: unknown) => {
          if (closed || !child.connected) return;
          child.send(message as object, error => { if (error) { settle(new Error(RENDER_FAILURE)); kill(); } });
        };
        let started = false;
        child.on("message", async (message: unknown) => {
          if (!message || typeof message !== "object" || closed) return;
          const m = message as Record<string, unknown>;
          if (m.type === "ready" && !started && !settled) {
            started = true; send({ type: "render", url, maxBytes });
          } else if (m.type === "policy" && started && !settled && typeof m.url === "string" && Number.isSafeInteger(m.id)) {
            try {
              await robots.assertAllowed(assertPublicUrl(m.url).toString(), { signal: request.signal });
              if (!settled) send({ type: "policy", id: m.id, allowed: true });
            } catch (error) {
              policyError = error;
              send({ type: "policy", id: m.id, allowed: false });
            }
          } else if (m.type === "result" && started && !settled) {
            try {
              if (policyError) throw policyError;
              if (typeof m.html !== "string" || typeof m.url !== "string" || Buffer.byteLength(m.html) > maxBytes) throw new Error(RENDER_FAILURE);
              settle(undefined, { html: m.html, url: assertPublicUrl(m.url).toString() });
            } catch (error) { settle(error); kill(); }
            cleanupTimer = setTimeout(kill, this.cleanupMs);
          } else if (m.type === "error" && !settled) {
            const error = m.error && typeof m.error === "object" ? m.error as WorkerError : { kind: "failed" } as const;
            settle(policyError ?? decodeRenderError(error));
            cleanupTimer = setTimeout(kill, this.cleanupMs);
          }
        });
        child.once("error", () => { settle(new Error(RENDER_FAILURE)); kill(); });
        child.once("close", () => {
          closed = true;
          clearTimeout(cleanupTimer); clearTimeout(killTimer);
          settle(policyError ?? new Error(RENDER_FAILURE));
          // Keep the admission slot through profile removal too. Failed native
          // cleanup never permits reuse of this BrowserContext.
          void rm(ownedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
            .catch(() => { console.warn("阅读辅助进程临时目录清理失败。"); })
            .finally(() => { ownedRelease(); this.jobs.delete(job); finish(); });
        });
        request.signal.addEventListener("abort", cancel, { once: true });
        if (request.signal.aborted) cancel();
      });
    } finally {
      release?.();
      if (profile) await rm(profile, { recursive: true, force: true });
      request.dispose();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.gate.close(new Error("应用正在退出。"));
    for (const job of this.jobs) job.cancel();
    await Promise.allSettled([...this.operations, ...[...this.jobs].map(job => job.done)]);
  }
}
export const publicRenderWorkers = new RenderWorkerPool();
export class ManagedPageRenderer implements PageRenderer {
  constructor(private readonly robots = new RobotsPolicy(), private readonly workers = publicRenderWorkers) {}
  render(url: string, options?: PageRenderOptions): Promise<RenderedPage> { return this.workers.render(this.robots, url, options); }
}
