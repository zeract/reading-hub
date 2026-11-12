import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPublicUrl } from "../shared/url";
import { abortError, combineAbortSignals, throwIfAborted, withRequestTimeout } from "./cancellation";
import { TaskPool } from "./task-pool";
import { workerEnvironment } from "./render-worker-protocol";
export type ArticleViewerLauncher = (profile: string) => ChildProcess;
function launch(profile: string): ChildProcess {
    return spawn(process.execPath, [...(app.isPackaged ? [] : [path.join(__dirname, "index.js")]), "--reader-article-viewer"], { env: workerEnvironment(profile), stdio: ["ignore", "ignore", "ignore", "ipc"] });
}
/** User navigation gets a disposable process: no user profile, preload or
 * credentials. A slot lasts through process exit and profile removal. */
export class InAppArticleViewer {
    private readonly gate = new TaskPool(2, 8);
    private readonly jobs = new Set<{
        stop(): void;
        done: Promise<void>;
    }>();
    private readonly opening = new Set<Promise<void>>();
    private closing = false;
    private readonly shutdown = new AbortController();
    constructor(private readonly start: ArticleViewerLauncher = launch, private readonly cleanupMs = 7000) { }
    open(rawUrl: string, entryTitle: string, signal?: AbortSignal): Promise<void> {
        const pending = this.run(rawUrl, entryTitle, signal);
        this.opening.add(pending);
        void pending.finally(() => this.opening.delete(pending)).catch(() => undefined);
        return pending;
    }
    private async run(rawUrl: string, title: string, signal?: AbortSignal): Promise<void> {
        throwIfAborted(signal);
        const url = assertPublicUrl(rawUrl).toString();
        const combined = combineAbortSignals(signal, this.shutdown.signal);
        const request = withRequestTimeout(combined.signal, 30000, "原文窗口打开超时，请稍后重试。");
        let release: (() => void) | undefined, profile: string | undefined;
        try {
            release = await this.gate.acquire({ signal: request.signal });
            throwIfAborted(request.signal);
            if (this.closing)
                throw new Error("应用正在退出。");
            profile = await mkdtemp(path.join(tmpdir(), "reading-hub-article-"));
            throwIfAborted(request.signal);
            const child = this.start(profile), ownedProfile = profile, ownedRelease = release;
            profile = undefined;
            release = undefined;
            await new Promise<void>((resolve, reject) => {
                let settled = false, exited = false, killing = false;
                let killTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
                let finish!: () => void;
                const done = new Promise<void>(r => finish = r);
                const settle = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    request.signal.removeEventListener("abort", cancel);
                    request.dispose();
                    if (error) reject(error);
                    else resolve();
                };
                const kill = () => {
                    if (exited || killing) return;
                    killing = true;
                    child.kill("SIGTERM");
                    killTimer = setTimeout(() => {
                        if (!exited) child.kill("SIGKILL");
                    }, 1_000);
                };
                const cancel = () => {
                    settle(abortError(request.signal));
                    kill();
                };
                const job = {
                    stop: () => {
                        settle(new Error("应用正在退出。"));
                        kill();
                    },
                    done
                };
                this.jobs.add(job);
                child.on("message", (message: unknown) => {
                    const m = message as {
                        type?: string;
                    };
                    if (m?.type === "ready" && !settled) {
                        child.send({ type: "open", url, title: title.slice(0, 500) }, error => {
                            if (error) {
                                settle(new Error("原文窗口无法打开，请稍后重试。"));
                                kill();
                            }
                        });
                    }
                    else if (m?.type === "opened")
                        settle();
                    else if (m?.type === "quit-requested") {
                        app.quit();
                    }
                    else if (m?.type === "closing") {
                        cleanupTimer ??= setTimeout(kill, this.cleanupMs);
                    }
                    else if (m?.type === "error") {
                        settle(new Error("原文窗口无法打开，请稍后重试。"));
                        kill();
                    }
                });
                child.once("error", () => {
                    settle(new Error("原文窗口无法打开，请稍后重试。"));
                    kill();
                });
                child.once("close", () => {
                    exited = true;
                    clearTimeout(killTimer);
                    clearTimeout(cleanupTimer);
                    settle(new Error("原文窗口已关闭，请重试。"));
                    void rm(ownedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => console.warn("原文窗口临时目录清理失败。")).finally(() => {
                        ownedRelease();
                        this.jobs.delete(job);
                        finish();
                    });
                });
                request.signal.addEventListener("abort", cancel, { once: true });
                if (request.signal.aborted)
                    cancel();
            });
        }
        finally {
            release?.();
            if (profile)
                await rm(profile, { recursive: true, force: true });
            request.dispose();
            combined.dispose();
        }
    }
    beginShutdown(): void {
        this.closing = true;
        this.shutdown.abort(new Error("应用正在退出。"));
        this.gate.close(new Error("应用正在退出。"));
        for (const job of this.jobs)
            job.stop();
    }
    async close(): Promise<void> {
        this.beginShutdown();
        await Promise.allSettled([...this.opening, ...[...this.jobs].map(job => job.done)]);
    }
}
