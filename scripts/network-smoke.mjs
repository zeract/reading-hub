import { app, session, protocol } from "electron";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AiService } from "../dist/main/main/ai-service.js";
import { configureChromiumNetwork, chromiumFetch } from "../dist/main/main/network.js";
import { requestJsonWithTimeout } from "../dist/main/main/json-response.js";

app.setPath("userData", await mkdtemp(join(tmpdir(), "reading-hub-ai-network-data-")));
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
    return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  protocolRegistered = true;
  for (const provider of providers) {
    const url = provider === "openai" ? "https://api.openai.com" : "https://api.deepseek.com";
    await session.defaultSession.cookies.set({ url, name: "fixture-session", value: "fixture-cookie", secure: true });
    let text = "";
    const answer = await service.askStream(request(provider), (delta) => { text += delta; });
    assert.equal(answer.text, "Fixture answer");
    assert.equal(text, "Fixture answer");
  }
  assert.equal(protocolRequests, 4);
  mode = "redirect";
  for (const provider of providers) await assert.rejects(service.askStream(request(provider), () => {}), /允许范围/);
  assert.equal(protocolRequests, 6);
  await session.defaultSession.cookies.set({ url: "https://api.example.com", name: "fixture-api-session", value: "fixture-cookie", secure: true });
  const json = await requestJsonWithTimeout((url, init) => {
    assert.equal(init.credentials, "omit");
    return chromiumFetch(url, init);
  }, "https://api.example.com/fixture-api", {
    headers: { authorization: "Bearer fixture-api-key" }
  }, undefined, 2_000);
  assert.deepEqual(json.payload, { fixture: true });
  assert.equal(apiRequests, 2);
  console.log("Reading Hub network smoke test passed: both AI providers use local proxy; native SSE/JSON, same-origin redirects, real HTTP cookie control, API credential omission, explicit authorization and cross-origin rejection verified.");
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
