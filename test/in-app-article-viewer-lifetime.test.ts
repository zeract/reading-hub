import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ quit: vi.fn() }));
vi.mock("electron", () => ({ app: { quit: mocks.quit } }));
import { InAppArticleViewer, type ArticleViewerLauncher } from "../src/main/in-app-article-viewer";
function child() {
    const emitter = new EventEmitter() as any;
    emitter.connected = true;
    emitter.send = vi.fn((message: any, callback?: () => void) => callback?.());
    emitter.kill = vi.fn(() => { queueMicrotask(() => emitter.emit("close", 0)); return true; });
    return emitter;
}
const viewers: InAppArticleViewer[] = [];
afterEach(async () => { await Promise.all(viewers.splice(0).map(viewer => viewer.close())); vi.useRealTimers(); mocks.quit.mockReset(); });
async function launchFixture() {
    const children: ReturnType<typeof child>[] = [], profiles: string[] = [];
    const launcher = vi.fn((profile: string) => { profiles.push(profile); const instance = child(); children.push(instance); return instance; });
    const viewer = new InAppArticleViewer(launcher as ArticleViewerLauncher, 20);
    viewers.push(viewer);
    return { viewer, launcher, children, profiles };
}
it("validates/cancels before allocation and never starts a late process after shutdown", async () => {
    const f = await launchFixture(), controller = new AbortController();
    controller.abort(new Error("left"));
    await expect(f.viewer.open("https://example.com/post", "Fixture", controller.signal)).rejects.toThrow("left");
    await expect(f.viewer.open("https://127.0.0.1/post", "Fixture")).rejects.toThrow();
    expect(f.launcher).not.toHaveBeenCalled();
    const pending = f.viewer.open("https://example.com/post", "Fixture");
    const rejected = expect(pending).rejects.toThrow("退出");
    await f.viewer.close();
    await rejected;
    expect(f.launcher).not.toHaveBeenCalled();
});
it("bounds visible processes, queues further requests and only reuses a slot after exit/profile cleanup", async () => {
    const f = await launchFixture();
    const first = f.viewer.open("https://example.com/one", "One"), second = f.viewer.open("https://example.com/two", "Two"), third = f.viewer.open("https://example.com/three", "Three");
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    f.children.forEach(c => c.emit("message", { type: "ready" }));
    expect(f.children.flatMap(c => c.send.mock.calls.map((call: any[]) => call[0]))).toEqual(expect.arrayContaining([{ type: "open", url: "https://example.com/one", title: "One" }, { type: "open", url: "https://example.com/two", title: "Two" }]));
    f.children.forEach(c => c.emit("message", { type: "opened" }));
    await Promise.all([first, second]);
    expect(f.launcher).toHaveBeenCalledTimes(2);
    f.children[0].emit("close", 0);
    await vi.waitFor(() => expect(f.children).toHaveLength(3));
    await expect(access(f.profiles[0])).rejects.toThrow();
    f.children[2].emit("message", { type: "opened" });
    await third;
    await f.viewer.close();
    expect(f.children[1].kill).toHaveBeenCalled();
    expect(f.children[2].kill).toHaveBeenCalled();
});
it("reclaims failed native cleanup without disabling later original-page navigation and routes explicit quit to the owner", async () => {
    const f = await launchFixture(), pending = f.viewer.open("https://example.com/post", "Fixture");
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    const instance = f.children[0];
    instance.emit("message", { type: "opened" });
    await pending;
    instance.emit("message", { type: "quit-requested" });
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    instance.emit("message", { type: "closing" });
    await vi.waitFor(() => expect(instance.kill).toHaveBeenCalledWith("SIGTERM"));
    const next = f.viewer.open("https://example.com/next", "Next");
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    f.children[1].emit("message", { type: "opened" });
    await next;
});
