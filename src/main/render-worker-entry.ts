import { app } from "electron";
import { IsolatedPageRenderer } from "./page-renderer";
import { RenderSessionPool } from "./render-session-pool";
import { RobotsPolicy } from "./robots";
import { encodeRenderError } from "./render-worker-protocol";
import { assertPublicUrl } from "../shared/url";

// No database, credential service, preload or application lifecycle is loaded.
const profile = process.env.READING_HUB_RENDER_PROFILE;
if (!process.send || !profile) app.exit(1);
else {
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.commandLine.appendSwitch("log-level", "3");
  app.on("window-all-closed", () => {});
  // This child never owns user writes. If its host disappears, do not wait
  // for Electron's potentially stalled native teardown without a supervisor.
  process.once("disconnect", () => process.kill(process.pid, "SIGKILL"));
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let nextPolicy = 0;
  let started = false;
  const send = (message: object) => new Promise<void>((resolve, reject) => {
    process.send!(message, error => error ? reject(error) : resolve());
  });
  const robots = { assertAllowed(url: string) {
    const id = ++nextPolicy;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void send({ type: "policy", id, url }).catch(reject);
    });
  } } as RobotsPolicy;
  const sessions = new RenderSessionPool(1, 0);
  const renderer = new IsolatedPageRenderer(robots, sessions);
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    if (m.type === "policy" && typeof m.id === "number") {
      const waiter = pending.get(m.id); pending.delete(m.id);
      if (m.allowed === true) waiter?.resolve(); else waiter?.reject(new Error("页面策略拒绝。"));
    } else if (m.type === "render" && !started) {
      started = true;
      void (async () => {
        try {
          if (typeof m.url !== "string" || !Number.isSafeInteger(m.maxBytes) || (m.maxBytes as number) < 1 || (m.maxBytes as number) > 8_000_000) throw new Error("无效渲染请求。");
          const page = await renderer.render(assertPublicUrl(m.url).toString(), { maxBytes: m.maxBytes as number });
          await send({ type: "result", ...page });
        } catch (error) {
          await send({ type: "error", error: encodeRenderError(error) }).catch(() => undefined);
        } finally {
          await sessions.close();
          app.exit();
        }
      })();
    }
  });
  void app.whenReady().then(() => send({ type: "ready" })).catch(() => app.exit(1));
}
