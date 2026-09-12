import { createHash } from "node:crypto";
import type { ReadingDatabase } from "./database";
import type { ArticleReader } from "./article-reader";
import { AiServiceError, type AiService } from "./ai-service";
import { throwIfAborted } from "./cancellation";
import { parseRewriteSettings, type ArticleRewrite, type RewriteSettings } from "../shared/rewrite";
import { runRewritePipeline, reviewRewrite } from "./rewrite-pipeline";
import { rewriteText, REWRITE_PROMPT_VERSION, RewriteContentError } from "./rewrite-content";
/** Durable user-requested jobs, independent of reader windows and source synchronization. */
export class RewriteService {
    private closing = false;
    private started = false;
    private worker?: Promise<void>;
    private active?: {
        job: ArticleRewrite;
        controller: AbortController;
    };
    private unsubscribe?: () => void;
    constructor(private readonly database: ReadingDatabase, private readonly articles: Pick<ArticleReader, "read">, private readonly ai: Pick<AiService, "rewriteChunk">) { }
    start(): void {
        if (this.started || this.closing)
            return;
        this.started = true;
        this.database.rewrites.recover();
        this.unsubscribe = this.database.onLibraryChanged(() => {
            if (this.active && !this.database.getEntry(this.active.job.entryId))
                this.active.controller.abort();
        });
        this.kick();
    }
    configure(input: RewriteSettings): RewriteSettings {
        if (this.closing)
            throw new Error("应用正在退出。");
        const settings = parseRewriteSettings(input);
        this.database.rewrites.configure(settings);
        return settings;
    }
    enqueue(entryId: string, kind: "generate" | "review" = "generate"): ArticleRewrite {
        if (this.closing)
            throw new Error("应用正在退出。");
        if (!this.database.getEntry(entryId))
            throw new Error("文章已不存在，请刷新列表。");
        if (kind === "review" && !this.database.rewrites.get(entryId)?.result?.sections)
            throw new RewriteContentError("当前改写不支持分节检查，请重新生成后再检查；已有中文仍可阅读。");
        const settings = this.database.rewrites.settings();
        if (!settings)
            throw new Error("请先在设置 → AI 功能中选择中文改写使用的模型。");
        const job = this.database.rewrites.enqueue(entryId, settings, kind);
        this.kick();
        return job;
    }
    cancel(entryId: string): ArticleRewrite | undefined {
        this.database.rewrites.cancel(entryId);
        if (this.active?.job.entryId === entryId)
            this.active.controller.abort();
        return this.database.rewrites.get(entryId);
    }
    remove(entryId: string): void { this.cancel(entryId); this.database.rewrites.remove(entryId); }
    close(): Promise<void> {
        this.closing = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.active?.controller.abort();
        return this.worker || Promise.resolve();
    }
    private kick(): void {
        if (!this.started || this.closing || this.worker)
            return;
        // Defer work until the caller receives its queued record. No reader-window scope.
        this.worker = Promise.resolve().then(() => this.drain()).then(() => { this.worker = undefined; if (!this.closing && this.database.rewrites.next())
            this.kick(); }, error => { this.worker = undefined; throw error; });
        // Persisted jobs remain recoverable if a local storage error prevents draining.
        void this.worker.catch(() => undefined);
    }
    private async drain(): Promise<void> {
        while (!this.closing) {
            const job = this.database.rewrites.next();
            if (!job)
                return;
            const controller = new AbortController();
            this.active = { job, controller };
            try {
                await this.run(job, controller.signal);
            }
            catch (error) {
                const message = controller.signal.aborted ? "任务已中断，可手动重试；已有改写仍保留。"
                    : error instanceof AiServiceError || error instanceof RewriteContentError ? error.message : job.kind === "review" ? "无法完成对照检查；已保存中文仍可阅读，可稍后重新检查。" : "无法完成中文改写，请确认原文可读取及网络正常后重试。";
                this.database.rewrites.fail(job, message);
            }
            finally {
                this.active = undefined;
            }
        }
    }
    private async run(job: ArticleRewrite, signal: AbortSignal): Promise<void> {
        const entry = this.database.getEntry(job.entryId);
        if (!entry)
            return;
        this.database.rewrites.progress(job, 0, 0);
        const article = await this.articles.read(entry, this.database.getSource(entry.sourceId), { signal });
        throwIfAborted(signal);
        const text = rewriteText(article);
        let usedModel = job.settings.model;
        const sourceHash = createHash("sha256").update(text).digest("hex");
        const run: import("./rewrite-pipeline").RewriteRunner = async (stage, prompt, requestSignal) => {
            if (!this.database.getEntry(job.entryId)) throw new RewriteContentError("文章已删除，停止改写。");
            const answer = await this.ai.rewriteChunk(job.settings, prompt, requestSignal, stage);
            usedModel = answer.model;
            return answer.text;
        };
        const progress = (stage: import("../shared/rewrite").RewriteStage, completed: number, total: number) => this.database.rewrites.progress(job, completed, total, stage);
        if (job.kind === "review") {
            const saved = this.database.rewrites.get(job.entryId)?.result;
            if (!saved?.sections || saved.sourceHash !== sourceHash)
                throw new RewriteContentError("原文已变化，无法对照生成时的版本；已保存中文仍可阅读，可重新生成后检查。");
            const review = await reviewRewrite(text, saved.sourceTitle, saved.sections, run, signal, progress);
            throwIfAborted(signal);
            this.database.rewrites.finish(job, {...saved, review:{...review, provider:job.settings.provider, model:usedModel}});
            return;
        }
        const checkpointKey=(version:number)=>createHash("sha256").update(JSON.stringify({sourceHash,title:article.title,url:article.url,settings:job.settings,version})).digest("hex");
        const key=checkpointKey(REWRITE_PROMPT_VERSION);
        // v8–v10 change only model-facing representation, not source conversion or accepted
        // derived content. Reuse v7–v9's already-validated sections under identical inputs.
        const compatibleKeys=REWRITE_PROMPT_VERSION===10 ? [key,checkpointKey(9),checkpointKey(8),checkpointKey(7)] : [key];
        const resumedKey=compatibleKeys.find(candidate=>this.database.rewrites.checkpoint(job,candidate).length) || key;
        const result = await runRewritePipeline(text, article.title.slice(0,1000), run, signal, progress, {
            drafts: this.database.rewrites.checkpoint(job,resumedKey),
            document: this.database.rewrites.checkpointDocument(job,resumedKey),
            save: (drafts,document) => this.database.rewrites.saveCheckpoint(job,key,drafts,document)
        });
        throwIfAborted(signal);
        this.database.rewrites.finish(job, { ...result, provider: job.settings.provider, model: usedModel, createdAt: Date.now(), sourceUrl: article.url, sourceTitle: article.title, sourceHash, promptVersion: REWRITE_PROMPT_VERSION });
    }
}
