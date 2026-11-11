import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { RenderWorkerPool } from "../src/main/render-worker-pool";
import { workerEnvironment, encodeRenderError, decodeRenderError } from "../src/main/render-worker-protocol";

const pools: RenderWorkerPool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.close())); });
function fixture(mode: "hang" | "normal" | "policy" | "crash" = "normal") {
  const children: Array<EventEmitter & { connected: boolean; kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }> = [];
  const launch = () => {
    const child = Object.assign(new EventEmitter(), { connected: true, kill: vi.fn(), send: vi.fn() });
    child.kill.mockImplementation(() => { setImmediate(() => { child.connected = false; child.emit("close", 0); }); return true; });
    child.send.mockImplementation((m, callback) => {
      callback?.(null);
      if (m.type === "render") setImmediate(() => {
        if (mode === "crash") { child.connected = false; child.emit("close", 1); }
        else if (mode === "policy") child.emit("message", { type: "policy", id: 1, url: "https://example.com/redirect" });
        else {
          child.emit("message", { type: "result", url: m.url, html: "<p>Captured</p>" });
          if (mode === "normal") setImmediate(() => { child.connected = false; child.emit("close", 0); });
        }
      });
      if (m.type === "policy" && !m.allowed) child.emit("message", { type: "error", error: { kind: "failed" } });
    });
    children.push(child);
    setImmediate(() => child.emit("message", { type: "ready" }));
    return child as unknown as ChildProcess;
  };
  const pool = new RenderWorkerPool(launch, 15, 2000); pools.push(pool);
  const robots = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
  return { pool, children, robots };
}
it("returns captures before cleanup and retires stalled workers without poisoning subsequent jobs", async () => {
  const { pool, children, robots } = fixture("hang");
  const pages = await Promise.all(Array.from({ length: 5 }, () => pool.render(robots as never, "https://example.com/article")));
  expect(pages).toHaveLength(5);
  expect(children).toHaveLength(5);
  expect(children.slice(0, 4).every(c => c.kill.mock.calls.length === 1)).toBe(true);
});
it("retains slots until process close and drains cleanup on shutdown", async () => {
  const { pool, children, robots } = fixture("hang");
  await Promise.all([pool.render(robots as never, "https://example.com/a"), pool.render(robots as never, "https://example.com/b")]);
  const queued = pool.render(robots as never, "https://example.com/c").catch(e => e);
  await pool.close();
  expect((await queued).message).toContain("退出");
  expect(children).toHaveLength(2);
  expect(children.every(c => !c.connected)).toBe(true);
  await expect(pool.render(robots as never, "https://example.com/d")).rejects.toThrow("退出");
});
it("preserves the host policy error across redirect IPC and worker failure", async () => {
  const { pool, robots } = fixture("policy");
  const denied = new Error("robots denied"); robots.assertAllowed.mockRejectedValue(denied);
  await expect(pool.render(robots as never, "https://example.com/a")).rejects.toBe(denied);
  expect(robots.assertAllowed).toHaveBeenCalledWith("https://example.com/redirect", expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
it("bounds active and queued cancellation, and a crash does not disable the pool", async () => {
  const { pool, children, robots } = fixture("crash");
  await expect(pool.render(robots as never, "https://example.com/a")).rejects.toThrow("异常结束");
  await expect(pool.render(robots as never, "https://example.com/b")).rejects.toThrow("异常结束");
  expect(children).toHaveLength(2);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(pool.render(robots as never, "https://example.com/a", { signal: controller.signal })).rejects.toThrow("cancelled");
});
it("does not inherit application credentials, audit flags or proxy passwords", () => {
  const env = workerEnvironment("/tmp/profile", { HOME: "/Users/test", DEEPSEEK_API_KEY: "secret", ELECTRON_RUN_AS_NODE: "1", READING_HUB_DB_PATH: "/private/db", HTTPS_PROXY: "http://user:password@localhost:7890" });
  expect(env).toEqual({ HOME: "/Users/test", READING_HUB_RENDER_PROFILE: "/tmp/profile", HTTPS_PROXY: "http://localhost:7890" });
});

it("drains an admitted operation when shutdown races profile creation", async () => {
  const { pool, children, robots } = fixture();
  const operation = pool.render(robots as never, "https://example.com/a").catch(error => error);
  await pool.close();
  expect((await operation).message).toContain("退出");
  expect(children).toHaveLength(0);
});

it("limits the queue and cancels a waiter without creating another process", async () => {
  const { pool, children, robots } = fixture("hang");
  await Promise.all([pool.render(robots as never, "https://example.com/a"), pool.render(robots as never, "https://example.com/b")]);
  const controller = new AbortController();
  const queued = pool.render(robots as never, "https://example.com/c", { signal: controller.signal }).catch(error => error);
  controller.abort(new Error("queued cancelled"));
  expect((await queued).message).toBe("queued cancelled");
  const waiting = Array.from({ length: 32 }, () => pool.render(robots as never, "https://example.com/wait").catch(error => error));
  await expect(pool.render(robots as never, "https://example.com/overflow")).rejects.toThrow("请求过多");
  expect(children).toHaveLength(2);
  await pool.close(); await Promise.all(waiting);
});

it("kills a worker that never becomes ready within the total deadline", async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, kill: vi.fn(), send: vi.fn() });
  child.kill.mockImplementation(() => { setImmediate(() => child.emit("close", 0)); return true; });
  const pool = new RenderWorkerPool(() => child as unknown as ChildProcess, 10, 20); pools.push(pool);
  await expect(pool.render({ assertAllowed: vi.fn() } as never, "https://example.com/a")).rejects.toThrow("页面渲染超时");
  await pool.close(); expect(child.kill).toHaveBeenCalledOnce();
});

it("preserves fixed document safety errors without transmitting raw native messages", () => {
  const fixed = "页面在读取过程中发生跳转，请重试。";
  expect(decodeRenderError(encodeRenderError(new Error(fixed))).message).toBe(fixed);
  const unknown = encodeRenderError(new Error("failure with secret credential and remote HTML"));
  expect(unknown).toEqual({ kind: "failed" });
  expect(decodeRenderError({ kind: "document", value: -1 }).message).toContain("异常结束");
});
