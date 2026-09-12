import { decodeRewriteResult, encodeRewriteResult } from "../rewrite-document";
import { parseRewriteSettings, type RewriteDocument } from "../../shared/rewrite";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { rewritePending, type ArticleRewrite, type RewriteSettings, type RewriteStage, type RewriteResult } from "../../shared/rewrite";
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
    stage: RewriteStage | null;
    kind: "generate" | "review";
};
/** One derived local document per entry; successful output survives failed regeneration. */
export class RewriteStore {
    constructor(private readonly db: Database.Database) { }
    settings(): RewriteSettings | undefined {
        const row = this.db.prepare("SELECT settings_json FROM rewrite_settings WHERE id=1").get() as {
            settings_json: string;
        } | undefined;
        return row ? parseRewriteSettings(JSON.parse(row.settings_json)) : undefined;
    }
    configure(settings: RewriteSettings): void {
        this.db.prepare("INSERT INTO rewrite_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json").run(JSON.stringify(settings));
    }
    get(entryId: string): ArticleRewrite | undefined {
        const row = this.db.prepare("SELECT * FROM article_rewrites WHERE entry_id=?").get(entryId) as Row | undefined;
        if (!row) return;
        let result: RewriteResult | undefined;
        let error=row.error || undefined;
        if(row.result_json) {
            try {
                result=decodeRewriteResult(row.result_json);
                const migrated=encodeRewriteResult(result);
                if(migrated!==row.result_json) this.db.transaction(()=>{
                    this.db.prepare("INSERT OR IGNORE INTO rewrite_migration_backups VALUES (?,?)").run(entryId,row.result_json);
                    this.db.prepare("UPDATE article_rewrites SET result_json=? WHERE entry_id=? AND result_json=?").run(migrated,entryId,row.result_json);
                })();
            } catch { error="保存的改写格式无法读取，原始记录仍保留；请检查应用版本。"; }
        }
        const settings=parseRewriteSettings(JSON.parse(row.settings_json));
        return { entryId:row.entry_id,jobId:row.job_id,kind:row.kind,status:row.status,settings,
            completedChunks:row.completed_chunks,totalChunks:row.total_chunks,updatedAt:row.updated_at,
            ...(row.stage ? {stage:row.stage}:{}), ...(error ? {error}:{}), ...(result ? {result}:{}) };

    }
    enqueue(entryId: string, settings: RewriteSettings, kind: "generate" | "review" = "generate"): ArticleRewrite {
        let previous: ArticleRewrite | undefined;
        try {previous=this.get(entryId);} catch { /* Explicit enqueue replaces unreadable settings, never the saved result. */ }
        if (rewritePending(previous))
            return previous!;
        const count = (this.db.prepare("SELECT COUNT(*) AS count FROM article_rewrites WHERE status IN ('queued','running')").get() as {
            count: number;
        }).count;
        if (count >= 20)
            throw new Error("改写队列已满，请等待部分文章完成后再试。");
        this.db.prepare(`INSERT INTO article_rewrites (entry_id,job_id,status,settings_json,updated_at,kind) VALUES (?,?,'queued',?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET job_id=excluded.job_id,status='queued',settings_json=excluded.settings_json,updated_at=excluded.updated_at,error=NULL,completed_chunks=0,total_chunks=0,stage=NULL,kind=excluded.kind`)
            .run(entryId, randomUUID(), JSON.stringify(settings), Date.now(), kind);
        return this.get(entryId)!;
    }
    next(): ArticleRewrite | undefined {
        // Isolate malformed jobs so one old record cannot stall the whole queue.
        const rows=this.db.prepare("SELECT entry_id FROM article_rewrites WHERE status='queued' ORDER BY updated_at,entry_id").all() as {entry_id:string}[];
        for(const row of rows) {
            try { return this.get(row.entry_id); }
            catch { this.db.prepare("UPDATE article_rewrites SET status='failed',error=? WHERE entry_id=? AND status='queued'").run("任务设置无法读取，请重新选择模型；已有记录仍保留。",row.entry_id); }
        }

    }
    recover(): void {
        this.db.prepare("UPDATE article_rewrites SET status='failed',error=?,updated_at=? WHERE status='running'").run("上次改写被中断，可手动重试；已有改写仍保留。", Date.now());
    }
    progress(job: ArticleRewrite, completed: number, total: number, stage?: RewriteStage): void {
        this.db.prepare("UPDATE article_rewrites SET status='running',completed_chunks=?,total_chunks=?,stage=?,updated_at=? WHERE entry_id=? AND job_id=? AND status IN ('queued','running')")
            .run(completed, total, stage ?? null, Date.now(), job.entryId, job.jobId);
    }
    finish(job: ArticleRewrite, result: RewriteResult): void {
        this.db.prepare("UPDATE article_rewrites SET status='complete',result_json=?,error=NULL,checkpoint_json=CASE WHEN kind='generate' THEN NULL ELSE checkpoint_json END,updated_at=? WHERE entry_id=? AND job_id=? AND status='running'")
            .run(encodeRewriteResult(decodeRewriteResult(JSON.stringify(result))), Date.now(), job.entryId, job.jobId);
    }
    checkpoint(job: ArticleRewrite, key: string): string[] {
        const row = this.db.prepare("SELECT checkpoint_json FROM article_rewrites WHERE entry_id=? AND job_id=?").get(job.entryId, job.jobId) as {checkpoint_json:string|null} | undefined;
        let value; try { value = row?.checkpoint_json ? JSON.parse(row.checkpoint_json) : undefined; } catch { return []; }
        return value?.key === key && Array.isArray(value.drafts) && value.drafts.length<=48 && value.drafts.every((draft:unknown)=>typeof draft==="string" && draft.length<=13000) ? value.drafts : [];
    }
    checkpointDocument(job: ArticleRewrite, key: string): RewriteDocument | undefined {
        const row=this.db.prepare("SELECT checkpoint_json FROM article_rewrites WHERE entry_id=? AND job_id=?").get(job.entryId,job.jobId) as {checkpoint_json:string|null}|undefined;
        try {const v=JSON.parse(row?.checkpoint_json || "null"); return v?.key===key ? v.document : undefined;} catch {return undefined;}
    }
    saveCheckpoint(job: ArticleRewrite, key: string, drafts: string[], document?: RewriteDocument): void {
        this.db.prepare("UPDATE article_rewrites SET checkpoint_json=? WHERE entry_id=? AND job_id=? AND status='running'")
            .run(JSON.stringify({key,drafts,document}), job.entryId, job.jobId);
    }
    hasLegacyCheckpoint(job:ArticleRewrite):boolean {
        const row=this.db.prepare("SELECT checkpoint_json FROM article_rewrites WHERE entry_id=? AND job_id=?").get(job.entryId,job.jobId) as {checkpoint_json:string|null}|undefined;
        try{return Boolean(JSON.parse(row?.checkpoint_json||"null")?.drafts?.length);}catch{return false;}
    }
    structuredCheckpoint(job:ArticleRewrite,key:string):import("../document-rewrite").DocumentCheckpoint|undefined {
        const row=this.db.prepare("SELECT checkpoint_json FROM article_rewrites WHERE entry_id=? AND job_id=?").get(job.entryId,job.jobId) as {checkpoint_json:string|null}|undefined;
        try{const v=JSON.parse(row?.checkpoint_json||"null");return v?.key===key && v.structured?.version===1 && Array.isArray(v.structured.patches) ? v.structured : undefined;}catch{return undefined;}
    }
    saveStructuredCheckpoint(job:ArticleRewrite,key:string,structured:import("../document-rewrite").DocumentCheckpoint):void {
        this.db.prepare("UPDATE article_rewrites SET checkpoint_json=? WHERE entry_id=? AND job_id=? AND status='running'").run(JSON.stringify({key,structured}),job.entryId,job.jobId);
    }
    fail(job: ArticleRewrite, error: string): void {
        this.db.prepare("UPDATE article_rewrites SET status='failed',error=?,updated_at=? WHERE entry_id=? AND job_id=? AND status IN ('queued','running')").run(error, Date.now(), job.entryId, job.jobId);
    }
    cancel(entryId: string): void {
        this.db.prepare("UPDATE article_rewrites SET status='cancelled',error=NULL,updated_at=? WHERE entry_id=? AND status IN ('queued','running')").run(Date.now(), entryId);
    }
    remove(entryId: string): void { this.db.prepare("DELETE FROM article_rewrites WHERE entry_id=?").run(entryId); }
}
