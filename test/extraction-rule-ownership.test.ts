import { expect, it, vi } from "vitest";
import { extractGenericPage, AUTOMATIC_RULE_REVISION, PUBLICATION_DATE_REVISION } from "../src/main/extractor";
import { GenericConnector } from "../src/main/connectors";
import { FEED_DISCOVERY_REVISION } from "../src/main/feed";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractionRule, Source } from "../src/shared/types";
const pageUrl = "https://example.com/";
const cards = [1,2].map((id) => `<article><h2><a href="/posts/${id}">A detailed technical article number ${id}</a></h2><time datetime="2026-08-02"></time><p>A substantial summary describing the article and its technical content.</p></article>`).join("");
const rule = (selection: "automatic" | "manual", extra = {}): ExtractionRule => ({ version: 1, selection, itemRootSelector: '.old-card', ...extra });

it.each([false,true])("repairs an empty automatic rule with two strong cards (renderer=%s)", (rendererRequired) => {
  const result = extractGenericPage(cards, pageUrl, rule('automatic',{rendererRequired}));
  expect(result.fallback).toBe(false);
  expect(result.entries).toHaveLength(2);
  expect(result.rule).toMatchObject({itemRootSelector:'article',selection:'automatic'});
  expect(result.rule?.rendererRequired).toBe(rendererRequired || undefined);
});

it("does not replace a manual root-only rule with a newly detected blog section", () => {
  const result = extractGenericPage('<h2>Blog Posts</h2><div>'+cards+'</div>',pageUrl,rule('manual'));
  expect(result.entries).toEqual([]);
  expect(result.rule).toMatchObject({itemRootSelector:'.old-card',selection:'manual'});
});

it("uses selected cards instead of competing JSON-LD", () => {
  const html = cards + '<script type="application/ld+json">{"@type":"Article","headline":"Unselected metadata","url":"/other"}</script>';
  const result = extractGenericPage(html,pageUrl,rule('manual',{itemRootSelector:'article'}));
  expect(result.entries.map((item)=>item.url)).toEqual(['https://example.com/posts/1','https://example.com/posts/2']);
});

it("retains the conservative behavior of legacy field-level selections", () => {
  const result=extractGenericPage(cards,pageUrl,{version:1,itemRootSelector:'.old-card',titleSelector:'h2'});
  expect(result.entries).toEqual([]);
});

it("does not recover from an empty automatic selector using a weak singleton", () => {
  const result=extractGenericPage('<a href="/one">An incidental navigation title</a>',pageUrl,rule('automatic'));
  expect(result.fallback).toBe(true);
  expect(result.rule?.itemRootSelector).not.toBe('a');
});

it("persists host-owned manual provenance when confirming a generated rule", () => {
  const db=new ReadingDatabase(':memory:');
  const source=db.createSource({url:pageUrl,title:'Fixture',kind:'generic',pollingEnabled:true});
  const cancelSource=vi.fn();
  const service=new SourceService(db,{} as never,{cancelSource} as never,{} as never);
  try {
    service.updateRule(source.id,rule('automatic',{itemRootSelector:'article'}));
    expect(db.getSource(source.id)?.extractionRule).toMatchObject({selection:'manual',itemRootSelector:'article'});
    expect(cancelSource).toHaveBeenCalledExactlyOnceWith(source.id);
  } finally {db.close();}
});

it("does not replace a manually selected list with a newly advertised Feed",async()=>{
  const getText=vi.fn(async(url:string)=>({url,status:200,contentType:'text/html',text:'<link type="application/rss+xml" href="/feed.xml">'+cards}));
  const connector=new GenericConnector({getText} as never);
  const source:Source={id:'fixture',url:pageUrl,title:'Fixture',kind:'generic',status:'active',pollingEnabled:true,consecutiveEmpty:0,failureCount:0,createdAt:1,updatedAt:1,
    extractionRule:rule('manual',{itemRootSelector:'article',autoRepairRevision:AUTOMATIC_RULE_REVISION,publicationDateRevision:PUBLICATION_DATE_REVISION,feedDiscoveryRevision:FEED_DISCOVERY_REVISION})};
  const result=await connector.fetchWithMetadata(source);
  expect(getText.mock.calls.map(([url])=>url)).toEqual([pageUrl]);
  expect(result.entries).toHaveLength(2);
  expect(result.extractionRule).toMatchObject({selection:'manual',itemRootSelector:'article'});
});

it("retains confirmed selection after restart and marks repeated empty results for review", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reading-hub-rule-owner-"));
  const path = join(directory, "fixture.sqlite");
  let db = new ReadingDatabase(path);
  const registry = new ConnectorRegistry();
  let html = cards;
  registry.register(new GenericConnector({ getText: async (url: string) => ({ url, status: 200, contentType: "text/html", text: html }) } as never));
  let sync = new SyncManager(db, registry);
  const source = db.createSource({ url: pageUrl, title: "Fixture", kind: "generic", pollingEnabled: true });
  const service = new SourceService(db, {} as never, sync, {} as never);
  try {
    service.updateRule(source.id, rule("automatic", { itemRootSelector: "article" }));
    expect((await sync.syncSource(source.id)).inserted).toBe(2);
    const saved = db.listEntries(source.id)[0]; db.markFavorite(saved.id, true);
    await sync.close(); db.close();
    db = new ReadingDatabase(path); sync = new SyncManager(db, registry);
    expect(db.getSource(source.id)?.extractionRule?.selection).toBe("manual");
    html = '<link type="application/rss+xml" href="/feed.xml"><script type="application/ld+json">{"@type":"Article","headline":"Unselected metadata","url":"/other"}</script><h2>Blog Posts</h2>' + cards.replaceAll("article", "section");
    for (let index = 0; index < 3; index++) expect((await sync.syncSource(source.id)).inserted).toBe(0);
    expect(db.getSource(source.id)).toMatchObject({ status: "needs_review", consecutiveEmpty: 3, failureCount: 0 });
    expect(db.listEntries(source.id)).toHaveLength(2);
    expect(db.listEntries(source.id).find((entry) => entry.id === saved.id)?.favorite).toBe(true);
  } finally {
    await sync.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
