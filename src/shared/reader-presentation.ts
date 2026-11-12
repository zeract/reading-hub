import {articleDocumentHtml} from "./article-document";
import type { ReaderArticle } from './types';
/** The reader owns one canonical tree. Legacy HTML-only results remain readable;
 * transient extraction HTML and duplicate tree serialization do not cross IPC. */
export function readerPresentation(article: ReaderArticle): ReaderArticle {
  const { importHtml: _temporary, ...result } = article;
  return article.document ? { ...result, contentHtml: '' } : result;
}

/** Explicit lazy compatibility for consumers that inspect/export HTML. */
export function readerContentHtml(article:ReaderArticle):string {
  return article.contentHtml || (article.document?articleDocumentHtml(article.document):"");
}
