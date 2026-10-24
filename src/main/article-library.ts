import type { CollectedArticleBody, Entry, ReaderArticle, Source } from "../shared/types";
import { isReaderSummaryContent } from "../shared/types";
import { assertPublicUrl, canonicalizeUrl } from "../shared/url";
import { ArticleReader, type ReaderReadOptions } from "./article-reader";
import { withArticleDocument } from "./article-document";
import { combineAbortSignals, throwIfAborted } from "./cancellation";
import type { ReadingDatabase } from "./database";
import { NetworkRequestError, type PublicHttpClient } from "./http";
import { ArticlePersistenceContentError, articleImageUrls } from "./persistence/article-store";
import { readerFailureDiagnostic } from "./reader-diagnostics";
import { ReaderImageHttpError } from "./reader-image-retry";
import { RobotsNetworkUnavailableError } from "./robots";

/** Local library ownership around the existing acquisition pipeline. No second extractor or renderer. */
export class ArticleLibrary {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private worker?: Promise<void>;
  private requested = false;
  private started = false;
  constructor(private readonly db: ReadingDatabase, private readonly reader: ArticleReader, private readonly http: PublicHttpClient) {}

  start(): void {
    this.started = true;
    this.db.articles.recover();
    this.db.articles.retryTransient();
    this.wake();
  }
  beginShutdown(): void { this.controller.abort(new Error("应用正在退出，已取消正文保存请求。")); }
  async close(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled([...this.pending, this.worker]);
  }
  onNetworkRestored(): void { this.db.articles.retryTransient(); this.wake(); }

  read(entry: Entry, source?: Source, options?: ReaderReadOptions): Promise<ReaderArticle> {
    return this.work(options?.signal, async signal => {
      const saved = !options?.refresh ? this.db.articles.read(entry.id) : undefined;
      if (saved) {
        this.wake();
        return this.reader.restoreSavedArticle(entry, saved, signal);
      }
      const article = await this.reader.read(entry, source, { ...options, signal });
      throwIfAborted(signal);
      this.db.articles.save(entry.id, article);
      this.wake();
      // A summary response must not replace the local full body even during an explicit refresh.
      return isReaderSummaryContent(article.contentMode) ? this.db.articles.read(entry.id) ?? article : article;
    });
  }

  readLanguageVariant(entry: Entry, source: Source | undefined, url: string, options?: ReaderReadOptions): Promise<ReaderArticle> {
    return this.work(options?.signal, async signal => {
      this.reader.assertLanguageVariant(entry.id, url, options?.inlineLanguage);
      const variant = JSON.stringify([canonicalizeUrl(url), options?.inlineLanguage ?? ""]);
      const saved = this.db.articles.read(entry.id, variant);
      if (saved) return this.reader.restoreSavedArticle(entry, saved, signal);
      const article = await this.reader.readLanguageVariant(entry, source, url, { ...options, signal });
      throwIfAborted(signal);
      this.db.articles.save(entry.id, article, variant);
      this.wake();
      return article;
    });
  }

  async prepareFeedBodies(entries: Entry[], bodies: CollectedArticleBody[] | undefined, signal?: AbortSignal): Promise<Map<string, ReaderArticle>> {
    const result = new Map<string, ReaderArticle>();
    const supplied = new Map(bodies?.map(body => [body.url, body]));
    for (const entry of entries) {
      throwIfAborted(signal);
      const body = supplied.get(entry.url);
      if (!body) continue;
      const article = await this.reader.readFeedBody(entry, body.html, body.baseUrl, { signal });
      if (article) result.set(entry.url, withArticleDocument(article));
    }
    return result;
  }

  /** Called inside the card/checkpoint transaction, after actual entry identity resolution. */
  commitCollected(entry: Entry, storedId: string, bodies?: Map<string, ReaderArticle>): void {
    const article = bodies?.get(entry.url);
    if (article) this.db.articles.save(storedId, article);
    this.db.articles.enqueue(storedId);
  }

  loadImage(entry: Entry, url: string, options?: Pick<ReaderReadOptions, "signal">): Promise<string> {
    return this.work(options?.signal, async signal => {
      const target = assertPublicUrl(url).toString();
      const cached = this.db.articles.image(entry.id, target);
      if (cached) return cached;
      // Only document-owned assets can become durable media; legacy rewrite assets share the same store.
      if (!this.db.articles.ownsImage(entry.id, target)) {
        const rewrite = this.db.rewrites.get(entry.id)?.result;
        const belongs = target === entry.imageUrl || (rewrite?.content && articleImageUrls({
          entryId: entry.id, title: entry.title, url: entry.url, renderProfile: "standard", contentHtml: "", document: rewrite.content
        }).includes(target));
        if (!belongs) throw new Error("图片不属于当前文章。");
        this.db.articles.registerImage(entry.id, target, entry.url);
      }
      const data = await this.http.getImageDataUrl(target, this.db.articles.imageReferrer(entry.id, target) ?? entry.url, { signal });
      throwIfAborted(signal);
      this.db.articles.saveImage(entry.id, target, data);
      return data;
    });
  }

  wake(): void {
    if (!this.started || this.controller.signal.aborted) return;
    this.requested = true;
    if (this.worker) return;
    this.worker = Promise.resolve().then(async () => {
      while (this.requested && !this.controller.signal.aborted) {
        this.requested = false;
        await this.drain();
      }
    }).catch(() => {
      // Storage errors leave durable running jobs for restart. Never log body/URL/error payloads.
      if (!this.controller.signal.aborted) console.warn("本地正文或图片保存未完成，已保留待处理记录。");
    }).finally(() => { this.worker = undefined; });
  }

  private async drain(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      const media = this.db.articles.pendingMedia();
      const acquisition = this.db.articles.nextAcquisition();
      if (!media.length && !acquisition) return;
      // One page at a time and at most four media requests; the HTTP client also enforces its shared pool.
      const mediaResults = await Promise.allSettled(media.map(async row => {
        if (!this.db.articles.beginMedia(row)) return;
        let data: string;
        try { data = await this.http.getImageDataUrl(row.url, row.referrer, { signal }); }
        catch (error) {
          if (signal.aborted) return;
          const reason = readerFailureDiagnostic("feed", error).reason;
          this.db.articles.finishMedia(row, error instanceof ReaderImageHttpError ? `http_${error.status}` : reason,
            error instanceof NetworkRequestError || error instanceof RobotsNetworkUnavailableError || error instanceof ReaderImageHttpError && error.status >= 500);
          return;
        }
        throwIfAborted(signal);
        try { this.db.articles.saveImage(row.entry_id, row.url, data); }
        catch (error) {
          if (!(error instanceof ArticlePersistenceContentError)) throw error;
          this.db.articles.finishMedia(row, "invalid_content", false);
        }
      }));
      // A failed write must not detach sibling downloads from shutdown draining.
      const mediaFailure = mediaResults.find(result => result.status === "rejected");
      if (mediaFailure?.status === "rejected") throw mediaFailure.reason;
      if (acquisition && !signal.aborted && this.db.articles.beginAcquisition(acquisition)) {
        const entry = this.db.getEntry(acquisition.entry_id);
        if (!entry) continue;
        let article: ReaderArticle;
        try { article = await this.reader.read(entry, this.db.getSource(entry.sourceId), { signal }); }
        catch (error) {
          if (signal.aborted) return;
          this.db.articles.finishAcquisition(entry.id, readerFailureDiagnostic("static", error).reason);
          continue;
        }
        throwIfAborted(signal);
        try { this.db.articles.save(entry.id, article); }
        catch (error) {
          if (!(error instanceof ArticlePersistenceContentError)) throw error;
          this.db.articles.finishAcquisition(entry.id, "invalid_content");
          continue;
        }
        this.db.articles.finishAcquisition(entry.id, isReaderSummaryContent(article.contentMode) ? "summary" : undefined);
      }
    }
  }

  private work<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = combineAbortSignals(signal, this.controller.signal);
    const pending = Promise.resolve().then(() => { throwIfAborted(combined.signal); return run(combined.signal!); });
    this.pending.add(pending);
    void pending.finally(() => { combined.dispose(); this.pending.delete(pending); }).catch(() => undefined);
    return pending;
  }
}
