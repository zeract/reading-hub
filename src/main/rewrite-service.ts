import { createHash } from "node:crypto";
import type { ReadingDatabase } from "./database";
import type { ArticleReader } from "./article-reader";
import { AiServiceError, type AiService } from "./ai-service";
import { throwIfAborted } from "./cancellation";
import { parseRewriteSettings, type ArticleRewrite, type RewriteSettings } from "../shared/rewrite";
import { MAX_AI_ANSWER_LENGTH } from "../shared/types";
import { rewriteText, splitRewriteText, REWRITE_PROMPT_VERSION, RewriteContentError } from "./rewrite-content";
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
    enqueue(entryId: string): ArticleRewrite {
        if (this.closing)
            throw new Error("应用正在退出。");
        if (!this.database.getEntry(entryId))
            throw new Error("文章已不存在，请刷新列表。");
        const settings = this.database.rewrites.settings();
        if (!settings)
            throw new Error("请先在设置 → AI 功能中选择中文改写使用的模型。");
        const job = this.database.rewrites.enqueue(entryId, settings);
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
                const message = controller.signal.aborted ? "改写已中断，可手动重试；已有改写仍保留。"
                    : error instanceof AiServiceError || error instanceof RewriteContentError ? error.message : "无法完成中文改写，请确认原文可读取及网络正常后重试。";
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
        const chunks = splitRewriteText(text);
        const parts: string[] = [];
        let outputLength = 0;
        let usedModel = job.settings.model;
        this.database.rewrites.progress(job, 0, chunks.length);
        for (let index = 0; index < chunks.length; index++) {
            throwIfAborted(signal);
            if (!this.database.getEntry(job.entryId))
                return;
            const answer = await this.ai.rewriteChunk(job.settings, `文章标题：${article.title.slice(0, 1000)}\n原文地址：${article.url}\n以下是文章的第 ${index + 1}/${chunks.length} 段，按原文顺序改写本段，不复述其他段，不遗漏本段结尾。\n\n<article-material>\n${chunks[index]}\n</article-material>`, signal);
            throwIfAborted(signal);
            if (!answer.text.trim() || answer.text.length >= MAX_AI_ANSWER_LENGTH)
                throw new RewriteContentError("模型未返回完整改写，已有改写仍保留；请更换模型后重试。");
            outputLength += answer.text.length;
            if (outputLength > 240000)
                throw new RewriteContentError("改写超过保存上限，已有改写仍保留。");
            parts.push(answer.text.trim());
            usedModel = answer.model;
            this.database.rewrites.progress(job, index + 1, chunks.length);
        }
        this.database.rewrites.finish(job, { markdown: parts.join("\n\n"), provider: job.settings.provider, model: usedModel, createdAt: Date.now(), sourceUrl: article.url, sourceTitle: article.title, sourceHash: createHash("sha256").update(text).digest("hex"), promptVersion: REWRITE_PROMPT_VERSION });
    }
}
