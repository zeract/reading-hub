import { GenericConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { expect, it, vi } from "vitest";
import { extractGenericPage, extractCalibrationCandidates } from "../src/main/extractor";
import { isManualExtractionRule } from "../src/main/extraction-rule";
import { isRecruitmentUrl } from "../src/main/content-eligibility";
import { ContentMaintenance } from "../src/main/content-maintenance";
import { ReadingDatabase } from "../src/main/database";
const job = 'https://jobs.ashbyhq.com/perplexity/8fe61c73-0daf-4432-a47d-44714c1ef764';
const page = 'https://research.perplexity.ai/';
const html = `<main><section><h2>All publications</h2><ul>${[1,2].map(n => `<li><a href="https://www.perplexity.ai/hub/blog/research-${n}"><h3>Research about jobs and AI ${n}</h3><time datetime="2026-09-09">Sep 9, 2026</time></a></li>`).join('')}</ul></section><section><h2>Work at Perplexity Research</h2><h3>Featured Roles</h3><ul><li><a href="${job}"><h3>Member of Technical Staff</h3>San Francisco</a></li><li><a href="https://example.com/application/42"><h3>Another researcher role</h3>Remote</a></li></ul></section></main>`;
it('repairs the actual legacy li rule while retaining cross-origin publications', () => {
  const rule = {version:1 as const,itemRootSelector:'li',rendererRequired:true,autoRepairRevision:5};
  expect(isManualExtractionRule(rule)).toBe(false);
  const result = extractGenericPage(html,page,rule);
  expect(result.entries.map(e=>e.url)).toEqual([1,2].map(n=>`https://www.perplexity.ai/hub/blog/research-${n}`));
  expect(result.rule?.selection).toBe('automatic');
  expect(result.rule?.itemRootSelector).not.toBe('li');
  expect(result.rule?.rendererRequired).toBe(true);
  expect(extractGenericPage(html,page,result.rule).entries).toEqual(result.entries);
});
it('applies qualification to manual selectors and calibration as well as detection',()=>{
  expect(extractGenericPage(html,page,{version:1,itemRootSelector:'li',selection:'manual'}).entries).toHaveLength(2);
  for(const candidate of extractCalibrationCandidates(html,page)) expect(candidate.preview.some(e=>e.url===job)).toBe(false);
});
it('does not turn a jobs discussion, a normal external article or a lookalike host into a job',()=>{
  expect(isRecruitmentUrl(job)).toBe(true);
  expect(isRecruitmentUrl(job.replace('jobs.ashbyhq.com','jobs.ashbyhq.com.example.org'))).toBe(false);
  expect(isRecruitmentUrl('https://example.com/blog/ai-and-jobs')).toBe(false);
});
it('cleans only job origins from generic sources, keeps favorites and shared content, and is idempotent',()=>{
  const db = new ReadingDatabase(':memory:');
  try {
    const generic=db.createSource({url:page,title:'Research',kind:'generic',pollingEnabled:true});
    const manual=db.createSource({url:'https://example.com/',title:'Saved',kind:'manual',pollingEnabled:false});
    const row=(sourceId:string,url:string,id:string,favorite=false)=>({id,sourceId,url,canonicalUrl:url,title:id,contentHash:id,read:true,favorite,createdAt:1});
    db.saveEntries([row(generic.id,job,'job'),row(generic.id,job.replace('8fe61c73','9fe61c73'),'favorite',true),row(generic.id,job.replace('8fe61c73','afe61c73'),'shared'),row(generic.id,'https://example.com/blog/jobs','article')]);
    db.saveEntries([row(manual.id,job.replace('8fe61c73','afe61c73'),'manual-origin')]);
    db.markFavorite("favorite", true);
    db.markRead("shared", true);
    const maintenance=new ContentMaintenance(db);
    expect(maintenance.runStartupMaintenance().recruitmentEntriesRemoved).toBe(2);
    expect(db.getEntry('job')).toBeUndefined();
    expect(db.getEntry('favorite')?.favorite).toBe(true);
    expect(db.getEntry('shared')?.read).toBe(true);
    expect(db.getEntry('shared')?.sourceId).toBe(manual.id);
    expect(db.getEntry('article')).toBeDefined();
    expect(maintenance.runStartupMaintenance().recruitmentEntriesRemoved).toBe(0);
  } finally {db.close();}
});

it('keeps preview ingestion qualified and repeated sync deduplicated with real publication dates', async()=>{
  const db=new ReadingDatabase(':memory:');
  const getText=vi.fn(async(url:string)=>({url,status:200,contentType:'text/html',text:html}));
  const registry=new ConnectorRegistry(); registry.register(new GenericConnector({getText} as never));
  const sync=new SyncManager(db,registry);
  const source=db.createSource({url:page,title:'Research',kind:'generic',pollingEnabled:true});
  try {
    expect(sync.savePreview(source,[{url:job,title:'Job'}])).toBe(0);
    expect((await sync.syncSource(source.id)).inserted).toBe(2);
    expect((await sync.syncSource(source.id)).inserted).toBe(0);
    const entries=db.listEntries(source.id);
    expect(entries).toHaveLength(2);
    expect(entries.every(e=>e.publishedAt===Date.parse('2026-09-09'))).toBe(true);
    expect(db.getSource(source.id)?.extractionRule?.selection).toBe('automatic');
    expect(getText.mock.calls.every(([url])=>url===page)).toBe(true);
  } finally {await sync.close();db.close();}
});
