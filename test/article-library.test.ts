import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArticleLibrary } from "../src/main/article-library";
import { ArticleReader } from "../src/main/article-reader";
import { withArticleDocument } from "../src/main/article-document";
import { ReadingDatabase } from "../src/main/database";
import { RssConnector, GenericConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { NetworkRequestError, type PublicHttpClient } from "../src/main/http";
import { RobotsDisallowedError } from "../src/main/robots";
import { contentNormalizer } from "../src/main/content-normalizer";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=";
const body = `<h2>技术说明</h2><p>${"可离线阅读的正文和 English text。".repeat(25)}</p><table><tr><th>字段</th><th>值</th></tr><tr><td>版本</td><td>1</td></tr></table><pre><code>const x = 1;\n  return x;</code></pre><p>$x^2$</p><img src="https://example.com/one.png"><figure><img src="https://example.com/two.png"><figcaption>图注</figcaption></figure>`;
const rss = (include = true) => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title>${include ? `<item><title>Original</title><link>https://example.com/post</link><pubDate>Fri, 23 Oct 2026 09:00:00 GMT</pubDate><description>Short excerpt</description><content:encoded><![CDATA[${body}]]></content:encoded></item>` : ""}</channel></rss>`;
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function location() { const dir = mkdtempSync(join(tmpdir(), "article-library-test-")); directories.push(dir); return join(dir, "library.sqlite"); }
function fixture(file = ":memory:", generic = false) {
  const db = new ReadingDatabase(file);
  const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: generic ? "generic" : "rss", pollingEnabled: true, ...(generic ? { extractionRule: { version: 1, feedUrl: "https://example.com/feed" } } : {}) });
  const state = { online: true, included: true, status: 200 };
  const http = {
    getText: vi.fn(async (url: string) => {
      if (!state.online) throw new NetworkRequestError();
      if (url !== source.url) throw new RobotsDisallowedError();
      return { status: state.status, url, text: state.status === 304 ? "" : rss(state.included), contentType: "application/rss+xml", etag: '"latest"' };
    }),
    getImageDataUrl: vi.fn(async () => { if (!state.online) throw new NetworkRequestError(); return IMAGE; })
  };
  const transport = http as unknown as PublicHttpClient;
  const renderer = { render: vi.fn(async () => { throw new RobotsDisallowedError(); }) };
  const reader = new ArticleReader(transport, renderer);
  const library = new ArticleLibrary(db, reader, transport);
  const registry = new ConnectorRegistry(); registry.register(generic ? new GenericConnector(transport, renderer) : new RssConnector(transport));
  const sync = new SyncManager(db, registry, undefined, undefined, library);
  return { db, source, state, http, transport, reader, library, sync, async close() { await sync.close(); await library.close(); db.close(); } };
}

it.each([false, true])("saves supplied Feed documents atomically for RSS and declared generic feeds (generic=%s)", async generic => {
  const f = fixture(":memory:", generic);
  try {
    f.library.start(); await f.sync.syncSource(f.source.id);
    const entry = f.db.listEntries(f.source.id)[0];
    await vi.waitFor(() => expect(f.db.articles.image(entry.id, "https://example.com/two.png")).toBe(IMAGE));
    expect(f.db.articles.image(entry.id, "https://example.com/one.png")).toBe(IMAGE);
    await f.library["worker"];
    f.state.included = false; await f.sync.syncSource(f.source.id);
    f.state.status = 304; await f.sync.syncSource(f.source.id);
    f.state.online = false; f.http.getText.mockClear(); f.http.getImageDataUrl.mockClear();
    const article = await f.library.read(entry, f.source);
    expect(article.contentMode).toBe("feed_body");
    expect(article.savedAt).toBeTypeOf("number");
    expect(article.contentHtml).toContain("<table>"); expect(article.contentHtml).toContain("const x = 1"); expect(article.contentHtml).toContain("katex");
    expect(await f.library.loadImage(entry, "https://example.com/one.png")).toBe(IMAGE);
    expect(await f.library.loadImage(entry, "https://example.com/two.png")).toBe(IMAGE);
    expect(f.http.getText).not.toHaveBeenCalled(); expect(f.http.getImageDataUrl).not.toHaveBeenCalled();
    expect(f.db.listEntries(f.source.id)).toHaveLength(1);
  } finally { await f.close(); }
});

it("survives database/process service restart with every body image available offline", async () => {
  const path = location(); const f = fixture(path); let id: string;
  try {
    f.library.start(); await f.sync.syncSource(f.source.id); id = f.db.listEntries(f.source.id)[0].id;
    await vi.waitFor(() => expect(f.db.articles.image(id, "https://example.com/two.png")).toBe(IMAGE));
    await f.library["worker"];
  } finally { await f.close(); }
  const db = new ReadingDatabase(path);
  const http = { getText: vi.fn(async () => { throw new NetworkRequestError(); }), getImageDataUrl: vi.fn(async () => { throw new NetworkRequestError(); }) };
  const lib = new ArticleLibrary(db, new ArticleReader(http as never, { render: vi.fn() }), http as never);
  try {
    lib.start(); const entry = db.getEntry(id!)!;
    expect((await lib.read(entry, db.getSource(entry.sourceId))).contentHtml).toContain("技术说明");
    for (const url of ["https://example.com/one.png", "https://example.com/two.png"]) expect(await lib.loadImage(entry, url)).toBe(IMAGE);
    expect(http.getText).not.toHaveBeenCalled(); expect(http.getImageDataUrl).not.toHaveBeenCalled();
  } finally { await lib.close(); db.close(); }
});

it("rolls back cards, bodies and validators together when body storage fails", async () => {
  const f = fixture(); const failure = vi.spyOn(f.db.articles, "save").mockImplementation(() => { throw new Error("fixture disk failure"); });
  try {
    await expect(f.sync.syncSource(f.source.id)).rejects.toThrow("fixture disk failure");
    expect(f.db.listEntries(f.source.id)).toHaveLength(0);
    expect(f.db.getSource(f.source.id)?.etag).toBeUndefined();
    expect(f.db.getSource(f.source.id)?.metadataRevision).toBeUndefined();
    failure.mockRestore(); await f.sync.syncSource(f.source.id);
    expect(f.db.listEntries(f.source.id)).toHaveLength(1); expect(f.db.getSource(f.source.id)?.etag).toBe('"latest"');
  } finally { await f.close(); }
});

it("does not downgrade an acquired original to a Feed body or summary", async () => {
  const f = fixture();
  try {
    await f.sync.syncSource(f.source.id); const entry = f.db.listEntries(f.source.id)[0];
    const original = withArticleDocument({ entryId: entry.id, url: entry.url, title: entry.title, renderProfile: "standard", contentHtml: `<p>${"Full original ".repeat(60)}</p>` });
    f.db.articles.save(entry.id, original);
    await f.sync.syncSource(f.source.id);
    expect(f.db.articles.read(entry.id)?.contentHtml).toContain("Full original");
    expect(f.db.articles.save(entry.id, { ...original, contentMode: "feed_summary" })).toBe(false);
    expect(() => f.db.articles.save(entry.id, withArticleDocument({ ...original, document: undefined, contentHtml: "<p></p>" }))).toThrow("正文为空");
    f.state.online = false;
    await expect(f.library.read(entry, f.source, { refresh: true })).rejects.toBeInstanceOf(Error);
    expect((await f.library.read(entry, f.source)).contentHtml).toContain("Full original");
  } finally { await f.close(); }
});

it("retains shared documents and images until the last source is removed, then rejects late writes", async () => {
  const f = fixture();
  try {
    f.library.start(); await f.sync.syncSource(f.source.id); const entry = f.db.listEntries(f.source.id)[0];
    await vi.waitFor(() => expect(f.db.articles.image(entry.id, "https://example.com/two.png")).toBe(IMAGE));
    const article = f.db.articles.read(entry.id)!;
    const second = f.db.createSource({ url: "https://other.example/feed", title: "Other", kind: "rss", pollingEnabled: true });
    f.db.saveEntries([contentNormalizer.normalize({ url: entry.url, title: entry.title }, second)]);
    f.db.deleteSource(f.source.id);
    expect(f.db.articles.read(entry.id)).toBeDefined(); expect(f.db.articles.image(entry.id, "https://example.com/one.png")).toBe(IMAGE);
    f.db.deleteSource(second.id);
    expect(f.db.articles.read(entry.id)).toBeUndefined(); expect(f.db.articles.image(entry.id, "https://example.com/one.png")).toBeUndefined();
    expect(f.db.articles.save(entry.id, article)).toBe(false);
    f.db.articles.registerImage(entry.id, "https://example.com/one.png", entry.url);
    f.db.articles.saveImage(entry.id, "https://example.com/one.png", IMAGE);
    expect(f.db.articles.ownsImage(entry.id, "https://example.com/one.png")).toBe(false);
  } finally { await f.close(); }
});

it.each(["generic", "zhihu_follow"] as const)("persists successfully acquired %s pages through the same reader wrapper", async kind => {
  const db = new ReadingDatabase(":memory:"); const source = db.createSource({ url: "https://example.com/", title: "Source", kind, pollingEnabled: true });
  const entry = contentNormalizer.normalize({ url: "https://example.com/article", title: "Original" }, source); db.saveEntries([entry]);
  const http = { getText: vi.fn(async () => ({ url: entry.url, contentType: "text/html", status: 200, text: `<article>${body}</article>` })), getImageDataUrl: vi.fn(async () => IMAGE) };
  const render = vi.fn(async () => ({ url: entry.url, html: `<article>${body}</article>` }));
  const library = new ArticleLibrary(db, new ArticleReader(http as never, { render }, kind === "zhihu_follow" ? render : undefined), http as never);
  try {
    await library.read(entry, source);
    http.getText.mockRejectedValue(new NetworkRequestError()); render.mockRejectedValue(new Error("session expired"));
    expect((await library.read(entry, source)).savedAt).toBeTypeOf("number");
    expect(db.articles.read(entry.id)?.document?.children.length).toBeGreaterThan(1);
  } finally { await library.close(); db.close(); }
});

it("does not save failed original extraction or summaries as complete documents", async () => {
  const f = fixture();
  try {
    const entry = contentNormalizer.normalize({ url: "https://example.com/missing", title: "Missing", summary: "A collected description that is only a summary and not a complete article." }, f.source); f.db.saveEntries([entry]);
    expect((await f.library.read(entry, f.source)).contentMode).toBe("feed_summary");
    expect(f.db.articles.read(entry.id)).toBeUndefined();
  } finally { await f.close(); }
});

it("recovers a stopped media job on restart and cannot leak arbitrary images through IPC", async () => {
  const f = fixture();
  try {
    await f.sync.syncSource(f.source.id); const entry = f.db.listEntries(f.source.id)[0];
    const job = f.db.articles.pendingMedia()[0]; f.db.articles.beginMedia(job);
    f.db.articles.recover(); expect(f.db.articles.pendingMedia()[0].attempts).toBe(0);
    f.library.start(); await vi.waitFor(() => expect(f.db.articles.image(entry.id, job.url)).toBe(IMAGE));
    await expect(f.library.loadImage(entry, "https://example.com/unowned.png")).rejects.toThrow("不属于");
    await expect(f.library.loadImage(entry, "http://127.0.0.1/private")).rejects.toThrow("本机");
  } finally { await f.close(); }
});

it("acquires only newly enqueued missing bodies and shuts down without resurrecting deleted entries", async () => {
  const f = fixture();
  try {
    const entry = contentNormalizer.normalize({ url: "https://example.com/post", title: "Original" }, f.source); f.db.saveEntries([entry]);
    // Background acquisition uses the same Reader and its Feed fallback, not a site-specific fetcher.
    f.library.commitCollected(entry, entry.id); f.library.start();
    await vi.waitFor(() => expect(f.db.articles.read(entry.id)).toBeDefined());
    await vi.waitFor(() => expect(f.db.articles.image(entry.id, "https://example.com/two.png")).toBe(IMAGE));
    f.db.deleteSource(f.source.id);
    expect(f.db.articles.pendingMedia()).toEqual([]); expect(f.db.articles.nextAcquisition()).toBeUndefined();
  } finally { await f.close(); }
});

it("cancels and drains a running media download, then resumes it on service restart", async () => {
  const path = location(), f = fixture(path);
  await f.sync.syncSource(f.source.id);
  const entry = f.db.listEntries(f.source.id)[0];
  const signals: AbortSignal[] = [];
  f.http.getImageDataUrl.mockImplementation((...args: unknown[]) => {
    const signal = (args[2] as { signal: AbortSignal }).signal; signals.push(signal);
    return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  f.library.start(); await vi.waitFor(() => expect(signals).toHaveLength(2));
  await f.close(); expect(signals.every(signal => signal.aborted)).toBe(true);
  const db = new ReadingDatabase(path), http = { getImageDataUrl: vi.fn(async () => IMAGE) };
  const library = new ArticleLibrary(db, new ArticleReader(http as never, { render: vi.fn() }), http as never);
  try {
    library.start(); await vi.waitFor(() => expect(db.articles.image(entry.id, "https://example.com/two.png")).toBe(IMAGE));
    expect(http.getImageDataUrl).toHaveBeenCalledTimes(2);
  } finally { await library.close(); db.close(); }
});

it("retries transient media failures with a finite budget without retrying permanent denial", async () => {
  const f = fixture();
  try {
    await f.sync.syncSource(f.source.id); const entry = f.db.listEntries(f.source.id)[0];
    f.http.getImageDataUrl.mockRejectedValue(new NetworkRequestError()); f.library.start();
    await vi.waitFor(() => expect(f.http.getImageDataUrl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.db.articles.pendingMedia()).toHaveLength(0));
    f.http.getImageDataUrl.mockResolvedValue(IMAGE); f.library.onNetworkRestored();
    await vi.waitFor(() => expect(f.db.articles.image(entry.id, "https://example.com/two.png")).toBe(IMAGE));
    const image = { entry_id: entry.id, url: "https://example.com/denied.png", referrer: entry.url, state: "pending", attempts: 0 };
    f.db.articles.registerImage(entry.id, image.url, entry.url); f.db.articles.beginMedia(image); f.db.articles.finishMedia(image, "robots_disallowed", false);
    f.library.onNetworkRestored(); expect(f.db.articles.pendingMedia()).toHaveLength(0);
  } finally { await f.close(); }
});

it("keeps the acquired Feed immediately and upgrades to a full original in the shared background queue", async () => {
  const f = fixture();
  const getText = f.http.getText.getMockImplementation()!;
  f.http.getText.mockImplementation(async url => url === "https://example.com/post" ? {
    url, status: 200, etag: "original", contentType: "text/html",
    text: `<html><head><title>Full original</title></head><body><article><h1>Full original</h1><p>${"Additional original details beyond the Feed. ".repeat(60)}</p></article></body></html>`
  } : getText(url));
  try {
    await f.sync.syncSource(f.source.id); const entry=f.db.listEntries(f.source.id)[0];
    expect(f.db.articles.read(entry.id)?.contentMode).toBe("feed_body");
    f.library.start(); await f.library["worker"];
    expect(f.db.articles.read(entry.id)?.contentHtml).toContain("Additional original details");
    expect(f.db.articles.read(entry.id)?.contentMode).not.toBe("feed_body");
    f.state.online=false;
    expect((await f.library.read(entry,f.source)).contentHtml).toContain("Additional original details");
  } finally { await f.close(); }
});

it("isolates invalid image bytes without blocking later batches or falsely marking the asset ready", async () => {
  const f = fixture();
  try {
    await f.sync.syncSource(f.source.id); const entry=f.db.listEntries(f.source.id)[0];
    for(let i=0;i<5;i++) f.db.articles.registerImage(entry.id,`https://example.com/extra-${i}.png`,entry.url);
    f.http.getImageDataUrl.mockImplementationOnce(async()=>"data:image/png;base64,");
    f.library.start(); await f.library["worker"];
    expect(f.db.articles.image(entry.id,"https://example.com/one.png")).toBeUndefined();
    expect(f.db.articles.image(entry.id,"https://example.com/extra-4.png")).toBe(IMAGE);
    expect(f.db.articles.pendingMedia()).toHaveLength(0);
    const calls=f.http.getImageDataUrl.mock.calls.length;
    f.library.onNetworkRestored(); await f.library["worker"];
    expect(f.http.getImageDataUrl).toHaveBeenCalledTimes(calls);
  } finally { await f.close(); }
});

it("keeps sibling downloads in the worker lifetime when a disk write fails", async () => {
  const f=fixture();let finish:((value:string)=>void)|undefined;
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>undefined);
  try {
    await f.sync.syncSource(f.source.id);
    const save=vi.spyOn(f.db.articles,"saveImage").mockImplementationOnce(()=>{throw new Error("fixture disk failure");});
    f.http.getImageDataUrl.mockResolvedValueOnce(IMAGE).mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;}));
    f.library.start();let settled=false;
    void f.library["worker"]!.then(()=>{settled=true;});
    await vi.waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
    expect(finish).toBeTypeOf("function");expect(settled).toBe(false);
    finish!(IMAGE);await f.library["worker"];
    expect(settled).toBe(true);expect(save).toHaveBeenCalledTimes(2);
  } finally { finish?.(IMAGE);await f.close();warn.mockRestore(); }
});

it('reclassifies legacy unknowns once while retaining the retry budget and explicit denials',async()=>{
 const f=fixture();try{
  await f.sync.syncSource(f.source.id);const entry=f.db.listEntries(f.source.id)[0];
  for(const reason of ['unknown','unclassified','robots_disallowed']){
   const row={entry_id:entry.id,url:`https://example.com/${reason}.png`,referrer:entry.url,state:'pending',attempts:0};
   f.db.articles.registerImage(entry.id,row.url,entry.url);f.db.articles.beginMedia(row);f.db.articles.finishMedia(row,reason,false);
  }
  f.db.articles.recover();
  const pending=f.db.articles.pendingMedia().filter(r=>r.url.endsWith('unknown.png'));
  expect(pending).toHaveLength(1);expect(pending[0].attempts).toBe(1);
  f.db.articles.beginMedia(pending[0]);f.db.articles.finishMedia(pending[0],'unclassified',false);f.db.articles.recover();
  expect(f.db.articles.pendingMedia().some(r=>/unknown|unclassified|robots_disallowed/.test(r.url))).toBe(false);
 }finally{await f.close()}
});

it('rechecks persisted original and images before queued background acquisition',async()=>{
 const f=fixture();try{
  await f.sync.syncSource(f.source.id);const entry=f.db.listEntries(f.source.id)[0];
  f.db.articles.save(entry.id,withArticleDocument({entryId:entry.id,title:entry.title,url:entry.url,renderProfile:'standard',contentHtml:body}));
  f.db.articles.saveImage(entry.id,'https://example.com/one.png',IMAGE);f.db.articles.saveImage(entry.id,'https://example.com/two.png',IMAGE);
  f.http.getText.mockClear();f.library.start();await f.library['worker'];
  expect(f.http.getText).not.toHaveBeenCalled();expect(f.http.getImageDataUrl).not.toHaveBeenCalled();
  const convert=vi.spyOn(f.reader,'readFeedBody');await f.sync.syncSource(f.source.id);
  expect(convert).not.toHaveBeenCalled();expect(f.http.getText).toHaveBeenCalledTimes(1);
 }finally{await f.close()}
});

it('coalesces concurrent original reads, isolates waiter cancellation, and preserves explicit refresh',async()=>{
 const f=fixture();try{
  const entry=contentNormalizer.normalize({url:'https://example.com/new-original',title:'Technical original'},f.source);f.db.saveEntries([entry]);
  let finish!:(article:ReturnType<typeof withArticleDocument>)=>void;
  const article=withArticleDocument({entryId:entry.id,title:entry.title,url:entry.url,renderProfile:'standard',contentHtml:body});
  const read=vi.spyOn(f.reader,'read').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue(article);
  const controller=new AbortController();const first=f.library.read(entry,f.source,{signal:controller.signal});const rejected=expect(first).rejects.toThrow();
  const second=f.library.read(entry,f.source);await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));controller.abort();await rejected;finish(article);await second;
  await f.library.read(entry,f.source);expect(read).toHaveBeenCalledTimes(1);
  await f.library.read(entry,f.source,{refresh:true});expect(read).toHaveBeenCalledTimes(2);
 }finally{await f.close()}
});

it('reuses exact owned image/referrer bytes across entries after restart, without borrowing other referrers or resurrecting deleted ownership',async()=>{
 const path=location(),f=fixture(path);let firstId:string,otherId:string;
 try{
  await f.sync.syncSource(f.source.id);const first=f.db.listEntries(f.source.id)[0];firstId=first.id;
  const otherSource=f.db.createSource({url:'https://example.com/other-feed',title:'Other feed',kind:'rss',pollingEnabled:true});
  const other=contentNormalizer.normalize({url:'https://example.com/other',title:'Other technical article'},otherSource);f.db.saveEntries([other]);otherId=other.id;
  f.db.articles.saveImage(firstId,'https://example.com/one.png',IMAGE);
  f.db.articles.registerImage(otherId,'https://example.com/one.png',first.url);
  f.db.articles.registerImage(otherId,'https://example.com/two.png',other.url);
  f.db.articles.saveImage(firstId,'https://example.com/two.png',IMAGE);
 }finally{await f.close()}
 const db=new ReadingDatabase(path),http={getImageDataUrl:vi.fn(async()=>IMAGE)};
 const library=new ArticleLibrary(db,{} as ArticleReader,http as unknown as PublicHttpClient);
 try{
  const other=db.getEntry(otherId!)!;
  expect(await library.loadImage(other,'https://example.com/one.png')).toBe(IMAGE);expect(http.getImageDataUrl).not.toHaveBeenCalled();
  expect(db.articles.image(other.id,'https://example.com/one.png')).toBe(IMAGE);
  await library.loadImage(other,'https://example.com/two.png');expect(http.getImageDataUrl).toHaveBeenCalledTimes(1);
  db.deleteSource(db.getEntry(firstId!)!.sourceId);
  expect(db.articles.image(other.id,'https://example.com/one.png')).toBe(IMAGE);
  expect(db.articles.reuseImage('deleted-entry','https://example.com/one.png')).toBe(false);
 }finally{await library.close();db.close()}
});

it('waits for shared reader cleanup on shutdown after all waiters are cancelled',async()=>{
 const f=fixture();try{
  const entry=contentNormalizer.normalize({url:'https://example.com/drain',title:'Drain read'},f.source);f.db.saveEntries([entry]);
  let finish!:(value:ReaderArticleForTest)=>void;type ReaderArticleForTest=Awaited<ReturnType<ArticleReader['read']>>;
  let transportSignal:AbortSignal|undefined;
  vi.spyOn(f.reader,'read').mockImplementation((_e,_s,options)=>{transportSignal=options?.signal;return new Promise(resolve=>{finish=resolve})});
  const result=f.library.read(entry,f.source);const rejected=expect(result).rejects.toThrow();
  await vi.waitFor(()=>expect(transportSignal).toBeDefined());
  let closed=false;const closing=f.library.close().then(()=>{closed=true});await rejected;
  expect(transportSignal?.aborted).toBe(true);expect(closed).toBe(false);
  finish(withArticleDocument({entryId:entry.id,title:entry.title,url:entry.url,renderProfile:'standard',contentHtml:body}));
  await closing;expect(closed).toBe(true);expect(f.db.articles.read(entry.id)).toBeUndefined();
 }finally{await f.close()}
});
