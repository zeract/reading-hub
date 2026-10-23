import {createHash} from 'node:crypto';
import type {ReaderArticle} from '../shared/types';
import type {ArticleRewrite, RewriteStage} from '../shared/rewrite';
import type {RewriteStore} from './persistence/rewrite-store';
import {rewriteArticleDocument, structuredSourceHash, type DocumentRewriteProtocol} from './document-rewrite';
import {rewriteText, REWRITE_PROMPT_VERSION} from './rewrite-content';
import {runRewritePipeline, type RewriteRunner} from './rewrite-pipeline';

/** Only this boundary selects historical checkpoint protocols. Normal reads never use it. */
export async function generateRewrite(article:ReaderArticle, job:ArticleRewrite, store:RewriteStore, run:RewriteRunner,
  signal:AbortSignal, progress:(stage:RewriteStage,done:number,total:number)=>void) {
  const keyFor=(sourceHash:string,version:number)=>createHash('sha256').update(JSON.stringify({sourceHash,title:article.title,url:article.url,settings:job.settings,version})).digest('hex');
  if(store.hasLegacyCheckpoint(job)) {
    const text=rewriteText({...article,contentHtml:article.importHtml ?? article.contentHtml});
    const sourceHash=createHash('sha256').update(text).digest('hex');
    const key=[10,9,8,7].map(version=>keyFor(sourceHash,version)).find(candidate=>store.checkpoint(job,candidate).length);
    if(key) {
      const result=await runRewritePipeline(text,article.title.slice(0,1000),run,signal,progress,{
        drafts:store.checkpoint(job,key),document:store.checkpointDocument(job,key),
        save:(drafts,document)=>store.saveCheckpoint(job,key,drafts,document)
      });
      return {...result,sourceHash,promptVersion:10};
    }
  }
  const sourceHash=structuredSourceHash(article.document!);
  const version=([11,12,REWRITE_PROMPT_VERSION] as const).find(v=>store.structuredCheckpoint(job,keyFor(sourceHash,v))?.patches.length) ?? REWRITE_PROMPT_VERSION;
  const protocol:DocumentRewriteProtocol=version===11?{kind:'text-nodes',version}:{kind:'paragraphs',version};
  const key=keyFor(sourceHash,version);
  const result=await rewriteArticleDocument(article.document!,article.title,run,signal,(done,total)=>progress('write',done,total),
    store.structuredCheckpoint(job,key),checkpoint=>store.saveStructuredCheckpoint(job,key,checkpoint),protocol);
  return {...result,schemaVersion:2 as const,sourceHash,promptVersion:version};
}
