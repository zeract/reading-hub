import {articleDocumentText} from "../shared/article-document";
import {withArticleDocument} from "./article-document";
import {generateRewrite} from "./rewrite-generation";
import type { ReadingDatabase } from "./database";
import type { ArticleReader } from "./article-reader";
import { AiServiceError, type AiService } from "./ai-service";
import { throwIfAborted } from "./cancellation";
import { parseRewriteSettings, type ArticleRewrite, type RewriteSettings } from "../shared/rewrite";
import { RewriteContentError } from "./rewrite-content";
import { isReaderSummaryContent, readerSummaryUnavailableMessage } from "../shared/types";
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
    async start(): Promise<void> {
        if (this.started || this.closing)
            return;
        this.started = true;
        await this.database.writeRewrite("recover");
        if(this.closing)return;
        this.unsubscribe = this.database.onLibraryChanged(() => {
            if (this.active && !this.database.getEntry(this.active.job.entryId))
                this.active.controller.abort();
        });
        this.kick();
    }
    async configure(input: RewriteSettings): Promise<RewriteSettings> {
        if (this.closing)
            throw new Error("应用正在退出。");
        const settings = parseRewriteSettings(input);
        await this.database.writeRewrite("configure",settings);
        return settings;
    }
    async enqueue(entryId: string): Promise<ArticleRewrite> {
        if (this.closing)
            throw new Error("应用正在退出。");
        if (!this.database.getEntry(entryId))
            throw new Error("文章已不存在，请刷新列表。");
        const settings = await this.database.writeRewrite("settings");
        if(this.closing)throw new Error("应用正在退出。");
        if (!settings)
            throw new Error("请先在设置 → AI 功能中选择中文改写使用的模型。");
        const job = await this.database.writeRewrite("enqueue",entryId, settings);
        this.kick();
        return job;
    }
    async cancel(entryId: string): Promise<ArticleRewrite | undefined> {
        await this.database.writeRewrite("cancel",entryId);
        if (this.active?.job.entryId === entryId)
            this.active.controller.abort();
        return this.database.writeRewrite("get",entryId);
    }
    async remove(entryId: string): Promise<void> { await this.cancel(entryId); await this.database.writeRewrite("remove",entryId); }
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
        this.worker = Promise.resolve().then(() => this.drain()).then(async () => { this.worker = undefined; if (!this.closing && await this.database.writeRewrite("next"))
            this.kick(); }, error => { this.worker = undefined; throw error; });
        // Persisted jobs remain recoverable if a local storage error prevents draining.
        void this.worker.catch(() => undefined);
    }
    private async drain(): Promise<void> {
        while (!this.closing) {
            const job = await this.database.writeRewrite("next");
            if (this.closing || !job)
                return;
            const controller = new AbortController();
            this.active = { job, controller };
            try {
                await this.run(job, controller.signal);
            }
            catch (error) {
                const message = controller.signal.aborted ? "任务已中断，可手动重试；已有改写仍保留。"
                    : error instanceof AiServiceError || error instanceof RewriteContentError ? error.message : "无法完成中文改写，请确认原文可读取及网络正常后重试。";
                await this.database.writeRewrite("fail",job, message);
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
        await this.database.writeRewrite("progress",job, 0, 0);
        // Legacy fingerprints depend on the transient sanitized import, which is not
        // reconstructed from a rendered local tree. Preserve their original read path.
        const legacy=await this.database.writeRewrite("hasLegacyCheckpoint",job);
        throwIfAborted(signal);
        const article = withArticleDocument(await this.articles.read(entry, this.database.getSource(entry.sourceId), { signal, refresh:legacy, legacyImport:legacy }));
        throwIfAborted(signal);
        const plain=articleDocumentText(article.document!);
        if(isReaderSummaryContent(article.contentMode))throw new RewriteContentError(readerSummaryUnavailableMessage(article.contentMode));
        if(plain.length<80 || plain.length>180000)throw new RewriteContentError("可读取的正文长度超出改写范围（80 至 18 万字符）。");
        let usedModel = job.settings.model;
        const run: import("./rewrite-pipeline").RewriteRunner = async (stage, prompt, requestSignal) => {
            if (!this.database.getEntry(job.entryId)) throw new RewriteContentError("文章已删除，停止改写。");
            const answer = await this.ai.rewriteChunk(job.settings, prompt, requestSignal, stage);
            usedModel = answer.model;
            return answer.text;
        };
        const progress = (stage: import("../shared/rewrite").RewriteStage, completed: number, total: number) => this.database.writeRewrite("progress",job, completed, total, stage);
        const store:import("./rewrite-generation").RewriteGenerationStore={
          hasLegacyCheckpoint:(...args)=>this.database.writeRewrite("hasLegacyCheckpoint",...args),
          checkpoint:(...args)=>this.database.writeRewrite("checkpoint",...args),
          checkpointDocument:(...args)=>this.database.writeRewrite("checkpointDocument",...args),
          saveCheckpoint:(...args)=>this.database.writeRewrite("saveCheckpoint",...args),
          structuredCheckpoint:(...args)=>this.database.writeRewrite("structuredCheckpoint",...args),
          saveStructuredCheckpoint:(...args)=>this.database.writeRewrite("saveStructuredCheckpoint",...args)
        };
        const result = await generateRewrite(article, job, store, run, signal, progress);
        throwIfAborted(signal);
        await this.database.writeRewrite("finish",job, {...result, provider:job.settings.provider, model:usedModel, createdAt:Date.now(), sourceUrl:article.url, sourceTitle:article.title});
    }
}
