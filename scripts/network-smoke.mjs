import { app, session, protocol } from "electron";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AiService } from "../dist/main/main/ai-service.js";
import { configureChromiumNetwork, chromiumFetch } from "../dist/main/main/network.js";
import { requestJsonWithTimeout } from "../dist/main/main/json-response.js";
import { IsolatedPageRenderer, RenderedPageTooLargeError } from "../dist/main/main/page-renderer.js";
import { extractReaderArticle } from "../dist/main/main/article-reader.js";
import { extractGenericPage } from "../dist/main/main/extractor.js";
import { discoverFeedUrls } from "../dist/main/main/feed.js";
import { findPublicArchiveUrls, parsePublishedArchive } from "../dist/main/main/archive-backfill.js";

app.setPath("userData", await mkdtemp(join(tmpdir(), "reading-hub-ai-network-data-")));
// The isolated renderer destroys its only window before returning its result.
// Keep this fixture alive until the assertions and explicit app.exit below.
app.on("window-all-closed", () => {});
await app.whenReady();
const cookieObservations = [];
const proxy = createServer((request, response) => {
  if (request.url === "/fixture-cookie") {
    cookieObservations.push(Boolean(request.headers.cookie));
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "fixture-response-session=fixture-value; Path=/" }); response.end("{}");
    return;
  }
  response.writeHead(502); response.end();
});
const connects = [];
proxy.on("connect", (request, socket) => {
  connects.push(request.url);
  socket.end("HTTP/1.1 502 Fixture unavailable\r\nContent-Length: 0\r\n\r\n");
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const values = new Map();
const service = new AiService({
  async getConnectorSecret(key) { return values.get(key) ?? null; },
  async setConnectorSecret(connector, id, value) {
    const key = `${connector}:${id}`;
    values.set(key, value);
    return key;
  },
  async clearConnectorSecret(key) { values.delete(key); }
});
const providers = ["openai", "deepseek"];
const request = (provider) => ({
  provider, question: "Fixture question",
  article: { title: "Fixture", sourceTitle: "Fixture", url: "https://example.com/article", text: "Fixture excerpt" }
});
let protocolRequests = 0;
let mode = "complete";
let lineEnding = "\n";
let exitCode = 0;
let protocolRegistered = false;
let apiRequests = 0;
const watchdog = setTimeout(() => {
  console.error("Native AI network fixture timed out");
  app.exit(1);
}, 15_000);
try {
  await configureChromiumNetwork({ HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` });
  for (const provider of providers) {
    await service.configure({ provider, apiKey: "fixture-key" });
    await assert.rejects(service.askStream(request(provider), () => {}), /无法连接/);
  }
  for (const host of ["api.openai.com:443", "api.deepseek.com:443"]) assert(connects.includes(host));
  // A real loopback HTTP response provides a positive cookie control. Custom
  // protocol handlers can bypass cookie attachment, so their empty headers
  // alone cannot prove that the underlying transport omits session credentials.
  const localUrl = `http://127.0.0.1:${proxy.address().port}/fixture-cookie`;
  await session.defaultSession.cookies.set({ url: localUrl, name: "fixture-local-session", value: "fixture-cookie" });
  for (const credentials of [undefined, "omit"]) {
    const response = await chromiumFetch(localUrl, { redirect: "manual", credentials });
    await response.text();
    const stored = await session.defaultSession.cookies.get({ url: localUrl, name: "fixture-response-session" });
    assert.equal(stored.length, credentials === "omit" ? 0 : 1);
    await session.defaultSession.cookies.remove(localUrl, "fixture-response-session");
  }
  assert.deepEqual(cookieObservations, [true, false]);
  // Native HTTPS requests are intercepted before any external connection.
  // The proxy above remains installed and never forwards traffic.
  protocol.handle("https", (request) => {
    protocolRequests++;
    const url = new URL(request.url);
    if (url.hostname === "api.example.com") {
      apiRequests++;
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.headers.get("authorization"), "Bearer fixture-api-key");
      if (url.pathname === "/fixture-api") return new Response(null, { status: 307, headers: { location: "/fixture-json" } });
      return new Response('{"fixture":true}', { headers: { "content-type": "application/json" } });
    }
    assert(["api.openai.com", "api.deepseek.com"].includes(url.hostname));
    assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
    assert.equal(request.headers.get("cookie"), null);
    if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://other.example/fixture" } });
    if (!url.pathname.endsWith("/fixture-stream")) return new Response(null, { status: 307, headers: { location: "/fixture-stream" } });
    const delta = url.hostname === "api.openai.com"
      ? { type: "response.output_text.delta", delta: "Fixture answer" }
      : { choices: [{ delta: { content: "Fixture answer" } }] };
    const terminal = url.hostname === "api.openai.com"
      ? JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Fixture final answer" }] }] } })
      : "[DONE]";
    const malformed = mode === "invalid-json" ? "{private-fixture" : mode === "invalid-delta"
      ? JSON.stringify(url.hostname === "api.openai.com" ? { type: "response.output_text.delta", delta: 42 } : { choices: [{ delta: { content: 42 } }] }) : undefined;
    const invalidFrame = malformed === undefined ? "" : `data: ${malformed}${lineEnding}${lineEnding}`;
    const payload = `data: ${JSON.stringify(delta)}${lineEnding}${lineEnding}${invalidFrame}data: ${terminal}${lineEnding}${lineEnding}data: ${JSON.stringify(delta)}${lineEnding}${lineEnding}`;
    // The provider has finished semantically, but its transport stays open.
    // Completion must cancel it and ignore the suffix without waiting for EOF.
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); }
    }), { headers: { "content-type": "text/event-stream" } });
  });
  protocolRegistered = true;
  for (const provider of providers) {
    const url = provider === "openai" ? "https://api.openai.com" : "https://api.deepseek.com";
    await session.defaultSession.cookies.set({ url, name: "fixture-session", value: "fixture-cookie", secure: true });
    for (lineEnding of ["\n", "\r\n", "\r"]) {
      let text = "";
      const answer = await service.askStream(request(provider), (delta) => { text += delta; });
      assert.equal(answer.text, provider === "openai" ? "Fixture final answer" : "Fixture answer");
      assert.equal(text, "Fixture answer");
    }
  }
  assert.equal(protocolRequests, 12);
  for (mode of ["invalid-json", "invalid-delta"]) {
    for (const provider of providers) {
      let text = "";
      await assert.rejects(service.askStream(request(provider), (delta) => { text += delta; }), { message: "AI 服务返回的数据格式无效，请稍后重试。" });
      assert.equal(text, "Fixture answer");
    }
  }
  assert.equal(protocolRequests, 20);
  mode = "redirect";
  for (const provider of providers) await assert.rejects(service.askStream(request(provider), () => {}), /允许范围/);
  assert.equal(protocolRequests, 22);
  await session.defaultSession.cookies.set({ url: "https://api.example.com", name: "fixture-api-session", value: "fixture-cookie", secure: true });
  const json = await requestJsonWithTimeout((url, init) => {
    assert.equal(init.credentials, "omit");
    return chromiumFetch(url, init);
  }, "https://api.example.com/fixture-api", {
    headers: { authorization: "Bearer fixture-api-key" }
  }, undefined, 2_000);
  assert.deepEqual(json.payload, { fixture: true });
  assert.equal(apiRequests, 2);
  const initialPageUrl = "https://redirect.example/start";
  const finalPageUrl = "https://rendered.example/papers/index.html";
  const oversizedPageUrl = "https://rendered.example/oversized";
  const patchedDomPageUrl = "https://rendered.example/patched-dom";
  const basedPageUrl = "https://rendered.example/posts/based.html";
  const snapshotPageUrl = "https://rendered.example/snapshots/original.html";
  const snapshotReloadUrl = "https://rendered.example/snapshots/reloaded.html";
  const slowResourcePageUrl = "https://rendered.example/slow-resource";
  const changedHistoryUrls = [];
  const checkedPages = [];
  const statusPageUrl = (status) => `https://rendered.example/http-status/${status}`;
  const interceptRenderedPage = (_event, contents) => {
    const executeSnapshot = contents.executeJavaScriptInIsolatedWorld.bind(contents);
    contents.executeJavaScriptInIsolatedWorld = async (...args) => {
      const capturedUrl = contents.getURL();
      const result = await executeSnapshot(...args);
      if (capturedUrl === snapshotPageUrl) {
        await contents.executeJavaScript('history.replaceState(null, "", "/after-history/current.html"); document.querySelector("article").textContent = "Changed after snapshot";');
        changedHistoryUrls.push(contents.getURL());
      }
      if (capturedUrl === snapshotReloadUrl) await contents.loadURL(snapshotReloadUrl);
      return result;
    };
    contents.session.protocol.handle("https", (request) => {
      assert.equal(request.headers.get("cookie"), null);
      if (request.url.startsWith("https://rendered.example/http-status/")) return new Response(`<article><h1>Readable error fixture</h1><p>${"This is an HTTP error, not an article. ".repeat(40)}</p></article>`, { status: Number(request.url.split("/").at(-1)), headers: { "content-type": "text/html" } });
      if (request.url === initialPageUrl) return new Response(null, { status: 302, headers: { location: finalPageUrl } });
      if (request.url === slowResourcePageUrl) return new Response('<article><h1>Ready document</h1><p>Usable DOM before image download completes.</p><img src="/never-finishes"></article>', { headers: { "content-type": "text/html" } });
      if (request.url === "https://rendered.example/never-finishes") return new Promise(() => {});
      if (request.url === finalPageUrl) return new Response(`<article><h1>Fixture article</h1><p>${"Synthetic paragraph. ".repeat(50)}</p><img src="figure.svg"><a href="appendix.html">Fixture appendix</a></article>`, { headers: { "content-type": "text/html" } });
      if (request.url === basedPageUrl) return new Response(`<head><base href="../assets/"><link rel="alternate" type="application/rss+xml" href="feed.xml"></head><article><h1>Fixture article</h1><time datetime="2026-08-02"></time><p>${"Synthetic paragraph. ".repeat(50)}</p><img src="figure.svg"><a href="appendix.html">Fixture appendix</a><a href="archive.html">Archives</a></article>`, { headers: { "content-type": "text/html" } });
      if ([snapshotPageUrl, snapshotReloadUrl].includes(request.url)) return new Response(`<article><h1>Original snapshot</h1><p>${"Original snapshot body. ".repeat(40)}</p><a href="appendix.html">Fixture appendix</a></article>`, { headers: { "content-type": "text/html" } });
      if (request.url === oversizedPageUrl) return new Response(`<script>window.Blob = class { get size() { return 0; } };</script><article>${"Synthetic content. ".repeat(200)}</article>`, { headers: { "content-type": "text/html" } });
      if (request.url === patchedDomPageUrl) return new Response('<script>Object.defineProperty(Element.prototype, "outerHTML", { get() { return "<article>Forged snapshot</article>"; } }); Object.defineProperty(Document.prototype, "URL", { get() { return "https://forged.example/"; } });</script><article>Actual DOM fixture</article>', { headers: { "content-type": "text/html" } });
      if (["https://rendered.example/papers/figure.svg", "https://rendered.example/assets/figure.svg"].includes(request.url)) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', { headers: { "content-type": "image/svg+xml" } });
      return new Response(null, { status: 404 });
    });
  };
  app.on("web-contents-created", interceptRenderedPage);
  try {
    const renderer = new IsolatedPageRenderer({ async assertAllowed(url) {
      assert([initialPageUrl, finalPageUrl, oversizedPageUrl, patchedDomPageUrl, basedPageUrl, snapshotPageUrl, snapshotReloadUrl, slowResourcePageUrl].includes(url) || url.startsWith("https://rendered.example/http-status/")); checkedPages.push(url);
    } });
    const page = await renderer.render(initialPageUrl);
    assert.equal(page.url, finalPageUrl);
    assert.deepEqual(checkedPages, [initialPageUrl, finalPageUrl]);
    const resourceStarted = Date.now();
    const resourcePage = await renderer.render(slowResourcePageUrl);
    assert(resourcePage.html.includes("Usable DOM before image download completes."));
    assert(Date.now() - resourceStarted < 5_000, "An unfinished image must not stall the document snapshot.");
    const article = extractReaderArticle(page.html, page.url, { id: "fixture", title: "Fixture", url: initialPageUrl });
    assert.equal(article.article.url, finalPageUrl);
    assert(article.article.contentHtml.includes('src="https://rendered.example/papers/figure.svg"'));
    assert(article.article.contentHtml.includes('href="https://rendered.example/papers/appendix.html"'));
    const basedPage = await renderer.render(basedPageUrl);
    const basedArticle = extractReaderArticle(basedPage.html, basedPage.url, { id: "fixture-base", title: "Fixture", url: basedPageUrl });
    assert.equal(basedArticle.article.url, basedPageUrl);
    assert(basedArticle.article.contentHtml.includes('src="https://rendered.example/assets/figure.svg"'));
    assert(basedArticle.article.contentHtml.includes('href="https://rendered.example/assets/appendix.html"'));
    const competingMetadata = '<script type="application/ld+json">{"@type":"Article","headline":"Unselected metadata","url":"https://rendered.example/unselected"}</script>';
    const listed = extractGenericPage(basedPage.html + competingMetadata, basedPage.url, { version: 1, selection: "manual", itemRootSelector: "article", titleSelector: "a:first-of-type" });
    assert.equal(listed.entries[0].url, "https://rendered.example/assets/appendix.html");
    assert.equal(listed.entries[0].imageUrl, "https://rendered.example/assets/figure.svg");
    assert.deepEqual(extractGenericPage(basedPage.html + competingMetadata, basedPage.url, { version: 1, selection: "manual", itemRootSelector: ".missing" }).entries, []);
    assert.deepEqual(discoverFeedUrls(basedPage.html, basedPage.url), ["https://rendered.example/assets/feed.xml"]);
    assert.deepEqual(findPublicArchiveUrls(basedPage.html, basedPage.url), ["https://rendered.example/assets/archive.html"]);
    assert.equal(parsePublishedArchive(basedPage.html, basedPage.url).length, 1);
    assert.equal(parsePublishedArchive(basedPage.html, basedPage.url)[0].url, "https://rendered.example/assets/appendix.html");
    await assert.rejects(renderer.render(oversizedPageUrl, { maxBytes: 256 }), RenderedPageTooLargeError);
    const cleanSnapshot = await renderer.render(patchedDomPageUrl);
    assert(cleanSnapshot.html.includes("Actual DOM fixture"));
    assert.equal(cleanSnapshot.url, patchedDomPageUrl);
    const stableSnapshot = await renderer.render(snapshotPageUrl);
    assert.equal(stableSnapshot.url, snapshotPageUrl);
    assert(stableSnapshot.html.includes("Original snapshot body."));
    assert.deepEqual(changedHistoryUrls, ["https://rendered.example/after-history/current.html"]);
    const stableArticle = extractReaderArticle(stableSnapshot.html, stableSnapshot.url, { id: "snapshot", title: "Snapshot", url: snapshotPageUrl });
    assert(stableArticle.article.contentHtml.includes('href="https://rendered.example/snapshots/appendix.html"'));
    await assert.rejects(renderer.render(snapshotReloadUrl), /页面在读取过程中发生跳转/);
    for (const status of [403, 404, 429, 503]) await assert.rejects(renderer.render(statusPageUrl(status)), { name: "RenderedPageHttpError", status });
  } finally { app.removeListener("web-contents-created", interceptRenderedPage); }
  console.log("Reading Hub network smoke test passed: AI semantic completion and final snapshots, LF/CRLF/CR, JSON, proxy and credential isolation, plus native rendered-page redirects and relative article URLs verified.");
} catch (error) {
  exitCode = 1;
  console.error(error);
  console.error({ protocolRequests, proxyRequests: connects.length });
} finally {
  clearTimeout(watchdog);
  if (protocolRegistered) protocol.unhandle("https");
  await service.close();
  await new Promise((resolve) => proxy.close(resolve));
  app.exit(exitCode);
}
