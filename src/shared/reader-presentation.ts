import type { ReaderArticle } from './types';
/** The reader owns one canonical tree. Legacy HTML-only results remain readable;
 * transient extraction HTML and duplicate tree serialization do not cross IPC. */
export function readerPresentation(article: ReaderArticle): ReaderArticle {
  const { importHtml: _temporary, ...result } = article;
  return article.document ? { ...result, contentHtml: '' } : result;
}
