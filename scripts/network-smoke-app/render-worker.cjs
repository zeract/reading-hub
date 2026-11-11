const { app } = require("electron");
const assert = require("node:assert/strict");
const initialPageUrl = "https://redirect.example/start";
const finalPageUrl = "https://rendered.example/papers/index.html";
const oversizedPageUrl = "https://rendered.example/oversized";
const patchedDomPageUrl = "https://rendered.example/patched-dom";
const basedPageUrl = "https://rendered.example/posts/based.html";
const snapshotPageUrl = "https://rendered.example/snapshots/original.html";
const snapshotReloadUrl = "https://rendered.example/snapshots/reloaded.html";
const slowResourcePageUrl = "https://rendered.example/slow-resource";
const hydrationPageUrl = "https://rendered.example/hydration";
const statusPageUrl = (status) => `https://rendered.example/http-status/${status}`;
const interceptRenderedPage = (_event, contents) => {
  const executeSnapshot = contents.executeJavaScriptInIsolatedWorld.bind(contents);
  contents.executeJavaScriptInIsolatedWorld = async (...args) => {
    const capturedUrl = contents.getURL();
    const result = await executeSnapshot(...args);
    if (capturedUrl === snapshotPageUrl) {
      await contents.executeJavaScript('history.replaceState(null, "", "/after-history/current.html"); document.querySelector("article").textContent = "Changed after snapshot";');
      process.send?.({ type: "fixture-history", url: contents.getURL() });
    }
    if (capturedUrl === snapshotReloadUrl) await contents.loadURL(snapshotReloadUrl);
    return result;
  };
  contents.session.protocol.handle("https", (request) => {
    assert.equal(request.headers.get("cookie"), null);
    if (request.url.startsWith("https://rendered.example/http-status/")) return new Response(`<article><h1>Readable error fixture</h1><p>${"This is an HTTP error, not an article. ".repeat(40)}</p></article>`, { status: Number(request.url.split("/").at(-1)), headers: { "content-type": "text/html" } });
    if (request.url === initialPageUrl) return new Response(null, { status: 302, headers: { location: finalPageUrl } });
    if (request.url === slowResourcePageUrl) return new Response('<article><h1>Ready document</h1><p>Usable DOM before image download completes.</p><img src="/never-finishes"></article>', { headers: { "content-type": "text/html" } });
    if (request.url === hydrationPageUrl) return new Response('<main id="app"></main><script async src="/delayed-script"></script>', { headers: { "content-type": "text/html" } });
    if (request.url === "https://rendered.example/delayed-script") return new Promise(resolve => setTimeout(() => resolve(new Response('document.querySelector("#app").innerHTML = "<article>Hydrated article content</article>"', { headers: { "content-type": "text/javascript" } })), 1_500));
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
require("../../dist/main/main/render-worker-entry.js");
