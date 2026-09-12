import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { rewritePending, type ArticleRewrite, type RewriteSettings, type RewriteResult } from "../../shared/rewrite";
type Row = {
    entry_id: string;
    job_id: string;
    status: ArticleRewrite["status"];
    settings_json: string;
    completed_chunks: number;
    total_chunks: number;
    updated_at: number;
    error: string | null;
    result_json: string | null;
};
/** One derived local document per entry; successful output survives failed regeneration. */
export class RewriteStore {
    constructor(private readonly db: Database.Database) { }
    settings(): RewriteSettings | undefined {
        const row = this.db.prepare("SELECT settings_json FROM rewrite_settings WHERE id=1").get() as {
            settings_json: string;
        } | undefined;
        return row ? JSON.parse(row.settings_json) : undefined;
    }
    configure(settings: RewriteSettings): void {
        this.db.prepare("INSERT INTO rewrite_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json").run(JSON.stringify(settings));
    }
    get(entryId: string): ArticleRewrite | undefined {
        const row = this.db.prepare("SELECT * FROM article_rewrites WHERE entry_id=?").get(entryId) as Row | undefined;
        return row ? { entryId: row.entry_id, jobId: row.job_id, status: row.status, settings: JSON.parse(row.settings_json), completedChunks: row.completed_chunks, totalChunks: row.total_chunks, updatedAt: row.updated_at, ...(row.error ? { error: row.error } : {}), ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}) } : undefined;
    }
    enqueue(entryId: string, settings: RewriteSettings): ArticleRewrite {
        const previous = this.get(entryId);
        if (rewritePending(previous))
            return previous!;
        const count = (this.db.prepare("SELECT COUNT(*) AS count FROM article_rewrites WHERE status IN ('queued','running')").get() as {
            count: number;
        }).count;
        if (count >= 20)
            throw new Error("改写队列已满，请等待部分文章完成后再试。");
        this.db.prepare(`INSERT INTO article_rewrites (entry_id,job_id,status,settings_json,updated_at) VALUES (?,?,'queued',?,?)
      ON CONFLICT(entry_id) DO UPDATE SET job_id=excluded.job_id,status='queued',settings_json=excluded.settings_json,updated_at=excluded.updated_at,error=NULL,completed_chunks=0,total_chunks=0`)
            .run(entryId, randomUUID(), JSON.stringify(settings), Date.now());
        return this.get(entryId)!;
    }
    next(): ArticleRewrite | undefined {
        const row = this.db.prepare("SELECT entry_id FROM article_rewrites WHERE status='queued' ORDER BY updated_at,entry_id LIMIT 1").get() as {
            entry_id: string;
        } | undefined;
        return row ? this.get(row.entry_id) : undefined;
    }
    recover(): void {
        this.db.prepare("UPDATE article_rewrites SET status='failed',error=?,updated_at=? WHERE status='running'").run("上次改写被中断，可手动重试；已有改写仍保留。", Date.now());
    }
    progress(job: ArticleRewrite, completed: number, total: number): void {
        this.db.prepare("UPDATE article_rewrites SET status='running',completed_chunks=?,total_chunks=?,updated_at=? WHERE entry_id=? AND job_id=? AND status IN ('queued','running')")
            .run(completed, total, Date.now(), job.entryId, job.jobId);
    }
    finish(job: ArticleRewrite, result: RewriteResult): void {
        this.db.prepare("UPDATE article_rewrites SET status='complete',result_json=?,error=NULL,updated_at=? WHERE entry_id=? AND job_id=? AND status='running'")
            .run(JSON.stringify(result), Date.now(), job.entryId, job.jobId);
    }
    fail(job: ArticleRewrite, error: string): void {
        this.db.prepare("UPDATE article_rewrites SET status='failed',error=?,updated_at=? WHERE entry_id=? AND job_id=? AND status IN ('queued','running')").run(error, Date.now(), job.entryId, job.jobId);
    }
    cancel(entryId: string): void {
        this.db.prepare("UPDATE article_rewrites SET status='cancelled',error=NULL,updated_at=? WHERE entry_id=? AND status IN ('queued','running')").run(Date.now(), entryId);
    }
    remove(entryId: string): void { this.db.prepare("DELETE FROM article_rewrites WHERE entry_id=?").run(entryId); }
}
