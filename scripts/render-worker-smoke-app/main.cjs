const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const { mkdtemp, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const base = path.resolve(__dirname, "../../dist/main/main");
const fixture = process.argv.includes("--fixture-child");
app.setPath("userData", process.env.READING_HUB_RENDER_PROFILE || path.join(tmpdir(), `reader-worker-smoke-${process.pid}`));
app.on("window-all-closed", () => {});
process.once("disconnect", () => app.exit());
async function child() {
  const { IsolatedPageRenderer } = require(path.join(base, "page-renderer.js"));
  const { RenderSessionPool } = require(path.join(base, "render-session-pool.js"));
  const sessions = new RenderSessionPool(1, 0);
  const acquire = sessions.acquire.bind(sessions);
  sessions.acquire = async signal => {
    const lease = await acquire(signal);
    lease.session.protocol.handle("https", () => new Response("<!doctype html><html><body><article><p>Native fixture document</p></article></body></html>", { headers: { "content-type": "text/html" } }));
    return { session: lease.session, release: async () => { await lease.release(); if (process.argv.includes("--stall-cleanup")) await new Promise(() => {}); } };
  };
  const renderer = new IsolatedPageRenderer({ assertAllowed: async () => {} }, sessions);
  process.on("message", async m => {
    if (m.type !== "render") return;
    const page = await renderer.render(m.url, { maxBytes: m.maxBytes });
    process.send({ type: "result", ...page }, async () => {
      if (process.argv.includes("--stall-cleanup")) return;
      await sessions.close(); app.exit();
    });
  });
  process.send({ type: "ready" });
}
async function parent() {
  const { RenderWorkerPool, ManagedPageRenderer, publicRenderWorkers } = require(path.join(base, "render-worker-pool.js"));
  const { workerEnvironment } = require(path.join(base, "render-worker-protocol.js"));
  const profiles = [], children = [];
  const pool = new RenderWorkerPool(profile => {
    profiles.push(profile);
    const c = spawn(process.execPath, [__dirname, "--fixture-child", ...(children.length === 0 ? ["--stall-cleanup"] : [])], { env: workerEnvironment(profile), stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(c); return c;
  }, 500, 15_000);
  const robots = { assertAllowed: async () => {} };
  const start = Date.now();
  try {
    const first = await pool.render(robots, "https://fixture.example/a");
    assert(first.html.includes("Native fixture document"));
    assert.equal(children[0].exitCode, null);
    const next = await Promise.all([pool.render(robots, "https://fixture.example/b"), pool.render(robots, "https://fixture.example/c")]);
    assert(next.every(page => page.html.includes("Native fixture document")));
    await pool.close();
    assert(children.every(c => c.exitCode !== null || c.signalCode));
    assert.equal(new Set(profiles).size, 3);
    for (const profile of profiles) await assert.rejects(stat(profile), { code: "ENOENT" });
    // Exercise the actual production entry dispatch and parent-owned robots,
    // using an explicit policy denial without any external request.
    const denied = new Error("fixture policy denial");
    const renderer = new ManagedPageRenderer({ assertAllowed: async () => { throw denied; } });
    await assert.rejects(renderer.render("https://example.com/a"), error => error === denied);
    await publicRenderWorkers.close();
    const orphanProfile = await mkdtemp(path.join(tmpdir(), "reader-worker-disconnect-"));
    try {
      const orphan = spawn(process.execPath, [path.join(base, "index.js"), "--reader-render-worker"], { env: workerEnvironment(orphanProfile), stdio: ["ignore", "ignore", "ignore", "ipc"] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { orphan.kill("SIGKILL"); reject(new Error("Disconnected worker did not exit")); }, 3000);
        orphan.once("error", reject);
        orphan.on("message", m => { if (m.type === "ready") orphan.disconnect(); });
        orphan.once("exit", (_code, signal) => { clearTimeout(timer); try { assert.equal(signal, "SIGKILL"); resolve(); } catch (error) { reject(error); } });
      });
    } finally { await rm(orphanProfile, { recursive: true, force: true }); }
    console.log(JSON.stringify({ nativeProcesses: children.length, stalledCleanupRecovered: true, isolatedProfilesRemoved: profiles.length, productionDispatchAndPolicy: true, hostDisconnectExited: true, durationMs: Date.now() - start }));
  } finally { await pool.close(); await publicRenderWorkers.close(); }
}
app.whenReady().then(fixture ? child : parent).then(() => { if (!fixture) app.exit(); }).catch(error => { console.error(error); app.exit(1); });
