import { readerPresentation } from "../src/shared/reader-presentation";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReaderConversionClient } from "../src/main/reader-conversion-client";
import { convertReaderContent } from "../src/main/reader-conversion";
import { ScientificMathRenderer } from "../src/main/mathjax-renderer";
const directory = mkdtempSync(path.join(tmpdir(), "reader-conversion-test-")), file = path.join(directory, "worker.cjs");
const entry = { id: "entry", sourceId: "source", url: "https://example.com/post", canonicalUrl: "https://example.com/post", title: "Fixture", contentHash: "hash", createdAt: 1, read: false, favorite: false };
beforeAll(() => { symlinkSync(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir"); buildSync({ entryPoints: [path.resolve("src/main/reader-conversion-worker.ts")], outfile: file, bundle: true, platform: "node", format: "cjs", packages: "external", logLevel: "silent" }); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("uses the same semantic conversion while keeping the host responsive during a long page", async () => {
    const client = new ReaderConversionClient(file), html = `<article><h1>Fixture</h1>${Array.from({ length: 1000 }, (_, i) => `<p>Paragraph ${i}: ${"A detailed explanation. ".repeat(12)}</p>`).join("")}<pre><code>const value = 1;</code></pre></article>`;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
        const actual = await client.convert({ kind: "page", html, url: entry.url, entry });
        expect(ticks).toBeGreaterThan(2);
        expect(actual?.article.document).toBeDefined();
        const expected = await convertReaderContent({ kind: "page", html, url: entry.url, entry }, new ScientificMathRenderer());
        expect(actual).toEqual({ ...expected, article: readerPresentation(expected!.article) });
        expect(actual?.article.contentHtml).toBe("");
        expect(actual?.article.importHtml).toBeUndefined();
    }
    finally {
        clearInterval(timer);
        await client.close();
    }
}, 30000);
it("stops the active CPU job, prioritizes queued foreground work, and drains cancellation/close", async () => {
    const fake = path.join(directory, "controlled.cjs");
    writeFileSync(fake, `const {parentPort}=require('node:worker_threads');parentPort.on('message',({input})=>{if(input.html==='block'){while(true){}}else setTimeout(()=>parentPort.postMessage({value:{article:{title:input.html},textLength:1}}),10)});`);
    const client = new ReaderConversionClient(fake), controller = new AbortController();
    const active = client.convert({ kind: "page", html: "block", url: entry.url, entry }, { signal: controller.signal });
    const rejected = expect(active).rejects.toThrow("leave");
    const order: string[] = [];
    const background = client.convert({ kind: "page", html: "background", url: entry.url, entry }, { priority: "background" }).then(v => order.push(v!.article.title));
    const foreground = client.convert({ kind: "page", html: "foreground", url: entry.url, entry }).then(v => order.push(v!.article.title));
    controller.abort(new Error("leave"));
    await rejected;
    await Promise.all([background, foreground]);
    expect(order).toEqual(["foreground", "background"]);
    await client.close();
    await expect(client.convert({ kind: "page", html: "late", url: entry.url, entry })).rejects.toThrow("退出");
});
it("retains fixed identity/language failures without transferring untrusted exception text", async () => {
    const client = new ReaderConversionClient(file);
    try {
        await expect(client.convert({ kind: "page", html: "<article>Fixture</article>", url: entry.url, entry, inlineLanguage: "zh" })).rejects.toThrow("同页语言版本已不可用");
    }
    finally {
        await client.close();
    }
});
it("reclaims a hung conversion within its execution budget so later foreground work can continue", async () => {
    const fake = path.join(directory, "hung.cjs");
    writeFileSync(fake, `const {parentPort}=require('node:worker_threads');parentPort.on('message',({input})=>{if(input.html==='block'){while(true){}}else parentPort.postMessage({value:{article:{title:input.html},textLength:1}})});`);
    const client = new ReaderConversionClient(fake, 250, 10);
    try {
        const first = client.convert({ kind: "page", html: "block", url: entry.url, entry });
        const second = client.convert({ kind: "page", html: "next", url: entry.url, entry });
        await expect(first).rejects.toThrow("超时");
        expect((await second)?.article.title).toBe("next");
    }
    finally {
        await client.close();
    }
});
it("cancels between scientific formulas through the shared inline conversion implementation", async () => {
    const math = new ScientificMathRenderer();
    (math as any).runtime = {};
    let finish!: (value: string) => void, calls = 0;
    math.renderAsync = async () => { calls++; return new Promise<string>(resolve => finish = resolve); };
    const html = '<article><p>' + "Scientific explanation. ".repeat(30) + '</p>' + Array.from({ length: 20 }, (_, i) => `<script type="math/tex; mode=display">x_${i}\\tag{${i + 1}}</script>`).join('') + '</article>';
    const controller = new AbortController(), pending = convertReaderContent({ kind: "page", html, url: entry.url, entry }, math, controller.signal);
    const rejected = expect(pending).rejects.toThrow("stop formulas");
    await new Promise(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
    controller.abort(new Error("stop formulas"));
    finish('<mjx-container><svg></svg></mjx-container>');
    await rejected;
    expect(calls).toBe(1);
});
it.each(["busy","timeout","failed","input_limit"] as const)("does not launch another browser fetch for local conversion %s",async kind=>{
 const {ArticleReader}=await import("../src/main/article-reader"),{ReaderConversionUnavailableError}=await import("../src/main/reader-conversion-errors"),{acquisitionFailure,acquisitionRetryAt}=await import("../src/main/article-acquisition");
 let browserReads=0,httpReads=0;
 const failure=new ReaderConversionUnavailableError(kind);
 const reader=new ArticleReader({getText:async()=>{httpReads++;return {text:"<article>Fixture</article>",url:entry.url,status:200,contentType:"text/html"};}} as any,{render:async()=>{browserReads++;throw new Error("unexpected extra fetch");}},undefined,undefined,{convert:async()=>{throw failure;},close:async()=>undefined});
 await expect(reader.read(entry)).rejects.toBe(failure);expect(httpReads).toBe(1);expect(browserReads).toBe(0);
 expect(acquisitionFailure(failure)).toBe(kind==="input_limit"?"size_limit":"conversion_unavailable");
 expect(acquisitionRetryAt(acquisitionFailure(failure),1,100)).toBe(kind==="input_limit"?null:60100);expect(acquisitionRetryAt(acquisitionFailure(failure),3,100)).toBeNull();
});
it.each(["count","bytes"])("bounds waiting conversion %s before allocating additional worker jobs",async limit=>{
 const {ReaderConversionUnavailableError}=await import("../src/main/reader-conversion-errors");
 const fake=path.join(directory,"admission.cjs");writeFileSync(fake,"require('node:worker_threads').parentPort.on('message',()=>{while(true){}})");
 const client=new ReaderConversionClient(fake),settled:Array<Promise<unknown>>=[];
 try{
  settled.push(client.convert({kind:"page",html:"block",url:entry.url,entry}).catch(()=>undefined));
  const input=limit==="bytes"?"x".repeat(12_000_000):"waiting";
  for(let i=0;i<(limit==="bytes"?2:16);i++)settled.push(client.convert({kind:"feed",html:input,url:entry.url,entry}).catch(()=>undefined));
  await expect(client.convert({kind:"feed",html:input,url:entry.url,entry})).rejects.toBeInstanceOf(ReaderConversionUnavailableError);
 }finally{await client.close();await Promise.all(settled);}
});
