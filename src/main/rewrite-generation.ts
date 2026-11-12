import {createHash} from 'node:crypto';
import type {ReaderArticle} from '../shared/types';
import type {ArticleRewrite, RewriteStage} from '../shared/rewrite';
import type {RewriteStore} from './persistence/rewrite-store';
import {rewriteArticleDocument, structuredSourceHash, type DocumentRewriteProtocol} from './document-rewrite';
import {rewriteText, REWRITE_PROMPT_VERSION} from './rewrite-content';
import {runRewritePipeline, type RewriteRunner} from './rewrite-pipeline';

/** Only this boundary selects historical checkpoint protocols. Normal reads never use it. */
type GenerationMethod="hasLegacyCheckpoint"|"checkpoint"|"checkpointDocument"|"saveCheckpoint"|"structuredCheckpoint"|"saveStructuredCheckpoint";
export type RewriteGenerationStore = {[K in GenerationMethod]:(...args:Parameters<RewriteStore[K]>)=>ReturnType<RewriteStore[K]>|Promise<ReturnType<RewriteStore[K]>>};
export async function generateRewrite(article:ReaderArticle, job:ArticleRewrite, store:RewriteGenerationStore, run:RewriteRunner,
  signal:AbortSignal, progress:(stage:RewriteStage,done:number,total:number)=>void|Promise<void>) {
  const keyFor=(sourceHash:string,version:number)=>createHash('sha256').update(JSON.stringify({sourceHash,title:article.title,url:article.url,settings:job.settings,version})).digest('hex');
  if(await store.hasLegacyCheckpoint(job)) {
    const text=rewriteText({...article,contentHtml:article.importHtml ?? article.contentHtml});
    const sourceHash=createHash('sha256').update(text).digest('hex');
    let key:string|undefined;
    for(const version of [10,9,8,7]){const candidate=keyFor(sourceHash,version);if((await store.checkpoint(job,candidate)).length){key=candidate;break;}}
    if(key) {
      const result=await runRewritePipeline(text,article.title.slice(0,1000),run,signal,progress,{
        drafts:await store.checkpoint(job,key),document:await store.checkpointDocument(job,key),
        save:(drafts,document)=>store.saveCheckpoint(job,key,drafts,document)
      });
      return {...result,sourceHash,promptVersion:10};
    }
  }
  const sourceHash=structuredSourceHash(article.document!);
  let version:11|12|13=REWRITE_PROMPT_VERSION;
  for(const candidate of [11,12,REWRITE_PROMPT_VERSION] as const){if((await store.structuredCheckpoint(job,keyFor(sourceHash,candidate)))?.patches.length){version=candidate;break;}}
  const protocol:DocumentRewriteProtocol=version===11?{kind:'text-nodes',version}:{kind:'paragraphs',version};
  const key=keyFor(sourceHash,version);
  const result=await rewriteArticleDocument(article.document!,article.title,run,signal,(done,total)=>progress('write',done,total),
    await store.structuredCheckpoint(job,key),checkpoint=>store.saveStructuredCheckpoint(job,key,checkpoint),protocol);
  return {...result,schemaVersion:2 as const,sourceHash,promptVersion:version};
}
