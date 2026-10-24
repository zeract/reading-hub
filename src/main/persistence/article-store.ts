import type Database from "better-sqlite3";
import { load } from "cheerio";
import { articleDocumentHtml, validArticleDocument } from "../../shared/article-document";
import { assertPublicUrl } from "../../shared/url";
import { isReaderSummaryContent, type ReaderArticle } from "../../shared/types";

export type MediaRecord = { entry_id: string; url: string; referrer: string; state: string; attempts: number };
export type AcquisitionRecord = { entry_id: string; state: string; attempts: number };
const MAX_DOCUMENT_BYTES = 24_000_000;
const IMAGE_DATA = /^data:(image\/(?:svg\+xml|avif|gif|jpe?g|png|webp|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]*={0,2})$/;

export class ArticlePersistenceContentError extends Error {}

/** Documents and owned media have the same lifetime as their entry, not an LRU cache. */
export class ArticleStore {
  constructor(private readonly db: Database.Database) {}

  read(entryId: string, variant = ""): ReaderArticle | undefined {
    const row = this.db.prepare("SELECT snapshot_json, saved_at FROM article_documents WHERE entry_id=? AND variant=?").get(entryId, variant) as { snapshot_json: string; saved_at: number } | undefined;
    if (!row) return;
    try {
      const article = JSON.parse(row.snapshot_json) as ReaderArticle;
      if (!validArticleDocument(article.document)) throw new Error();
      return { ...article, entryId, savedAt: row.saved_at, contentHtml: articleDocumentHtml(article.document) };
    } catch { throw new Error("本地正文格式无法读取，已保留数据；请检查应用版本。"); }
  }

  save(entryId: string, article: ReaderArticle, variant = ""): boolean {
    if (isReaderSummaryContent(article.contentMode)) return false;
    if (!validArticleDocument(article.document)) throw new ArticlePersistenceContentError("本地正文结构无效，未替换已有正文。");
    const content = load(articleDocumentHtml(article.document));
    if (!content.text().trim() && !content("img,video,math,svg").length) throw new ArticlePersistenceContentError("正文为空，未替换已有正文。");
    assertPublicUrl(article.url);
    const quality = article.contentMode === "feed_body" ? 1 : 2;
    // Persist an explicit allowlist. Import HTML, observers, credentials and runtime state never reach SQLite.
    const snapshot = JSON.stringify({ document: article.document, entryId, url: article.url, title: article.title,
      author: article.author, publishedAt: article.publishedAt, renderProfile: article.renderProfile,
      contentMode: article.contentMode, formulaDiagnostics: article.formulaDiagnostics,
      languageVariants: article.languageVariants, activeLanguage: article.activeLanguage, coverImageUrl: article.coverImageUrl });
    if (Buffer.byteLength(snapshot) > MAX_DOCUMENT_BYTES) throw new ArticlePersistenceContentError("正文超过本地保存大小限制，未替换已有正文。");
    return this.db.transaction(() => {
      // INSERT SELECT guards against late requests recreating deleted content.
      const result = this.db.prepare(`INSERT INTO article_documents(entry_id,variant,snapshot_json,quality,saved_at)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM entries WHERE id=?)
        ON CONFLICT(entry_id,variant) DO UPDATE SET snapshot_json=excluded.snapshot_json,quality=excluded.quality,saved_at=excluded.saved_at
        WHERE excluded.quality >= article_documents.quality`).run(entryId, variant, snapshot, quality, Date.now(), entryId);
      if (!result.changes) return false;
      for (const url of articleImageUrls(article)) this.registerImage(entryId, url, article.url);
      return true;
    })();
  }

  registerImage(entryId: string, rawUrl: string, rawReferrer: string): void {
    const url = assertPublicUrl(rawUrl).toString(), referrer = assertPublicUrl(rawReferrer).toString();
    this.db.prepare(`INSERT OR IGNORE INTO article_media(entry_id,url,referrer)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM entries WHERE id=?)`).run(entryId, url, referrer, entryId);
  }

  ownsImage(entryId: string, url: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM article_media WHERE entry_id=? AND url=?").get(entryId, url));
  }
  hasOriginal(entryId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM article_documents WHERE entry_id=? AND variant='' AND quality>=2").get(entryId));
  }
  hasOriginalForUrl(canonicalUrl: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM entries e JOIN article_documents d ON d.entry_id=e.id
      WHERE e.canonical_url=? AND d.variant='' AND d.quality>=2`).get(canonicalUrl));
  }

  /** Copy only an exact resource/referrer match into an already owned row.
   * Article lifetimes remain independent; no URL rewriting or orphan creation. */
  reuseImage(entryId: string, url: string): boolean {
    return Boolean(this.db.prepare(`UPDATE article_media AS target SET
      (mime,bytes)=(SELECT mime,bytes FROM article_media WHERE url=target.url AND referrer=target.referrer AND state='ready' LIMIT 1),
      state='ready',failure=NULL
      WHERE entry_id=? AND url=? AND state!='ready' AND EXISTS(
        SELECT 1 FROM article_media WHERE url=target.url AND referrer=target.referrer AND state='ready')`).run(entryId,url).changes);
  }
  imageReferrer(entryId: string, url: string): string | undefined {
    return (this.db.prepare("SELECT referrer FROM article_media WHERE entry_id=? AND url=?").get(entryId, url) as { referrer: string } | undefined)?.referrer;
  }

  image(entryId: string, rawUrl: string): string | undefined {
    const url = assertPublicUrl(rawUrl).toString();
    const row = this.db.prepare("SELECT mime,bytes FROM article_media WHERE entry_id=? AND url=? AND state='ready'").get(entryId, url) as { mime: string; bytes: Buffer } | undefined;
    return row ? `data:${row.mime};base64,${row.bytes.toString("base64")}` : undefined;
  }
  hasImage(entryId: string, url: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM article_media WHERE entry_id=? AND url=? AND state='ready'").get(entryId,url));
  }

  saveImage(entryId: string, rawUrl: string, data: string): void {
    const match = IMAGE_DATA.exec(data);
    if (!match) throw new ArticlePersistenceContentError("图片不是可保存的安全格式。");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 8_000_000) throw new ArticlePersistenceContentError("图片超过本地保存大小限制。");
    this.db.prepare("UPDATE article_media SET mime=?,bytes=?,state='ready',failure=NULL WHERE entry_id=? AND url=?")
      .run(match[1], bytes, entryId, assertPublicUrl(rawUrl).toString());
  }

  enqueue(entryId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO article_acquisitions(entry_id)
      SELECT id FROM entries WHERE id=? AND NOT EXISTS(SELECT 1 FROM article_documents WHERE entry_id=? AND variant='' AND quality>=2)`).run(entryId, entryId);
  }
  recover(): void {
    for (const table of ["article_media", "article_acquisitions"]) {
      this.db.prepare(`UPDATE ${table} SET state='pending',attempts=MAX(0,attempts-1) WHERE state='running'`).run();
    }
    // Legacy image failures conflated body transport errors, size and SVG
    // declarations. Reclassify once within the existing three-attempt budget;
    // new unknowns use "unclassified" and do not re-enter this compatibility path.
    this.db.prepare("UPDATE article_media SET state='pending' WHERE state='failed' AND failure='permanent:unknown' AND attempts<3").run();
  }
  pendingMedia(): MediaRecord[] {
    return this.db.prepare("SELECT entry_id,url,referrer,state,attempts FROM article_media WHERE state='pending' AND attempts<3 LIMIT 4").all() as MediaRecord[];
  }
  nextAcquisition(): AcquisitionRecord | undefined {
    return this.db.prepare("SELECT * FROM article_acquisitions WHERE state='pending' AND attempts<3 LIMIT 1").get() as AcquisitionRecord | undefined;
  }
  beginMedia(row: MediaRecord): boolean {
    return Boolean(this.db.prepare("UPDATE article_media SET state='running',attempts=attempts+1 WHERE entry_id=? AND url=? AND state='pending'").run(row.entry_id, row.url).changes);
  }
  finishMedia(row: MediaRecord, failure: string, retryable: boolean): void {
    this.db.prepare("UPDATE article_media SET state='failed',failure=? WHERE entry_id=? AND url=? AND state!='ready'").run((retryable ? "transient:" : "permanent:") + failure, row.entry_id, row.url);
  }
  beginAcquisition(row: AcquisitionRecord): boolean {
    return Boolean(this.db.prepare("UPDATE article_acquisitions SET state='running',attempts=attempts+1 WHERE entry_id=? AND state='pending'").run(row.entry_id).changes);
  }
  finishAcquisition(entryId: string, failure?: string): void {
    this.db.prepare("UPDATE article_acquisitions SET state=?,failure=? WHERE entry_id=?").run(failure ? "failed" : "done", failure ?? null, entryId);
  }
  retryTransient(): void {
    this.db.prepare("UPDATE article_media SET state='pending' WHERE state='failed' AND failure LIKE 'transient:%' AND attempts<3").run();
    this.db.prepare("UPDATE article_acquisitions SET state='pending' WHERE state='failed' AND failure IN ('network','robots_unavailable','timeout') AND attempts<3").run();
  }
}

export function articleImageUrls(article: ReaderArticle): string[] {
  const $ = load(article.document ? articleDocumentHtml(article.document) : article.contentHtml);
  const urls = new Set<string>();
  for (const node of $("img[src]").toArray()) {
    try { urls.add(assertPublicUrl($(node).attr("src")!).toString()); } catch { /* Not a public image asset. */ }
  }
  if (article.coverImageUrl) urls.add(assertPublicUrl(article.coverImageUrl).toString());
  return [...urls];
}
