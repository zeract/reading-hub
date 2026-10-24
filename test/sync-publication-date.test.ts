import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {ReadingDatabase} from '../src/main/database';
import {GenericConnector} from '../src/main/connectors';
import {ConnectorRegistry} from '../src/main/connector-registry';
import {SyncManager} from '../src/main/sync-manager';
import type {PublicHttpClient} from '../src/main/http';

it('reuses committed dates across restarts and sources, enriches new or undated entries, and accepts fresh homepage dates',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'reading-hub-date-')),path=join(directory,'library.sqlite');
 let db=new ReadingDatabase(path),manager:SyncManager|undefined;
 const first=Date.UTC(2024,0,2),updated=Date.UTC(2024,1,3);
 let fresh=false,added=false;
 const home=()=>`<main><article><h2><a href="/post?utm_source=homepage">Saved technical article about databases</a></h2>${fresh?'<time datetime="2024-02-03">Feb 3</time>':''}</article><article><h2><a href="/undated">Undated technical article about systems</a></h2></article>${added?'<article><h2><a href="/new">New technical article about compilers</a></h2></article>':''}</main>`;
 const http={getText:vi.fn(async(url:string)=>({url,status:200,contentType:'text/html',text:url.includes('/post')||url.endsWith('/new')?'<meta property="article:published_time" content="2024-01-02"><article><h1>Technical article</h1><p>Body</p></article>':url.endsWith('/undated')?'<article><p>No publication date</p></article>':home()}))};
 const start=()=>{const registry=new ConnectorRegistry();registry.register(new GenericConnector(http as unknown as PublicHttpClient));manager=new SyncManager(db,registry);};
 try{
  const source=db.createSource({url:'https://example.com/',title:'Blog',kind:'generic',pollingEnabled:true,extractionRule:{version:1,itemRootSelector:'article',selection:'manual'}});
  start();await manager!.syncSource(source.id);
  expect(db.listEntries(source.id).find(e=>e.title==='Saved technical article about databases')?.publishedAt).toBe(first);
  await manager!.close();db.close();db=new ReadingDatabase(path);start();http.getText.mockClear();added=true;
  await manager!.syncSource(source.id);
  expect(http.getText.mock.calls.map(c=>c[0])).not.toContain('https://example.com/post?utm_source=homepage');
  expect(http.getText.mock.calls.map(c=>c[0])).toContain('https://example.com/new');
  expect(http.getText.mock.calls.map(c=>c[0])).toContain('https://example.com/undated');
  expect(db.listEntries(source.id).find(e=>e.title==='Saved technical article about databases')?.publishedAt).toBe(first);
  const shared=db.createSource({url:'https://example.com/other',title:'Other archive',kind:'generic',pollingEnabled:true,extractionRule:{version:1,itemRootSelector:'article',selection:'manual'}});
  http.getText.mockClear();await manager!.syncSource(shared.id);
  expect(http.getText.mock.calls.some(c=>c[0].includes('/post'))).toBe(false);
  fresh=true;http.getText.mockClear();await manager!.syncSource(source.id);
  expect(db.listEntries(source.id).find(e=>e.title==='Saved technical article about databases')?.publishedAt).toBe(updated);
  expect(http.getText.mock.calls.some(c=>c[0].includes('/post'))).toBe(false);
 }finally{await manager?.close();db.close();rmSync(directory,{recursive:true,force:true});}
});
