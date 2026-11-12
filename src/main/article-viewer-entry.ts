import { app, BrowserWindow } from "electron";
import { assertPublicUrl } from "../shared/url";
import { configureChromiumSession } from "./network";
import { guardMainFrameNavigation } from "./navigation-policy";
import { RenderSessionPool } from "./render-session-pool";
const profile = process.env.READING_HUB_RENDER_PROFILE;
if (!profile || !process.send)
    app.exit(1);
else {
    app.setName("Reading Hub");
    if (process.platform === "darwin")
        app.setActivationPolicy("accessory");
    app.setPath("userData", profile);
    app.setPath("sessionData", profile);
    app.commandLine.appendSwitch("log-level", "3");
    app.on("window-all-closed", () => { });
    process.once("disconnect", () => process.kill(process.pid, "SIGKILL"));
    const sessions = new RenderSessionPool(1, 0), controller = new AbortController();
    let window: BrowserWindow | undefined, started = false, closing = false;
    const send = (message: object) => new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
    let release: (() => Promise<void>) | undefined;
    const close = async () => {
        if (closing)
            return;
        closing = true;
        controller.abort();
        await send({ type: "closing" }).catch(() => undefined);
        if (window && !window.isDestroyed()) {
            window.webContents.removeAllListeners("will-prevent-unload");
            window.destroy();
        }
        try {
            await release?.();
            await sessions.close();
        }
        finally {
            app.exit();
        }
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.once(signal, () => void close());
    app.on("before-quit", event => { event.preventDefault(); if (!closing)
        void send({ type: "quit-requested" }).catch(() => process.kill(process.pid, "SIGKILL")); });
    process.on("message", (message: unknown) => {
        const m = message as {
            type?: string;
            url?: string;
            title?: string;
        };
        if (m?.type !== "open" || started || closing)
            return;
        started = true;
        void (async () => {
            try {
                const url = assertPublicUrl(m.url ?? "").toString();
                const lease = await sessions.acquire(controller.signal);
                release = lease.release;
                if (closing) {
                    await release();
                    return;
                }
                await configureChromiumSession(lease.session);
                if (closing)
                    return;
                lease.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
                lease.session.setPermissionCheckHandler(() => false);
                window = new BrowserWindow({ show: true, width: 1080, height: 820, minWidth: 760, minHeight: 560, title: `Reading Hub · ${compact(m.title ?? "")}`, backgroundColor: "#ffffff", webPreferences: { session: lease.session, sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: false, spellcheck: false } });
                window.webContents.on("before-input-event", (event, input) => {
                    if (input.type === "keyDown" && input.key.toLowerCase() === "q" && (process.platform === "darwin" ? input.meta : input.control)) {
                        event.preventDefault();
                        void send({ type: "quit-requested" }).catch(() => process.kill(process.pid, "SIGKILL"));
                    }
                });
                window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
                window.webContents.on("will-attach-webview", event => event.preventDefault());
                guardMainFrameNavigation(window.webContents, next => Boolean(assertPublicUrl(next)));
                window.webContents.on("will-prevent-unload", event => event.preventDefault());
                window.webContents.on("page-title-updated", (_event, title) => { if (window && !window.isDestroyed())
                    window.setTitle(`Reading Hub · ${compact(title || m.title || "")}`); });
                window.once("closed", () => void close());
                void window.loadURL(url).catch(() => undefined);
                await send({ type: "opened" });
            }
            catch {
                await send({ type: "error" }).catch(() => undefined);
                await close();
            }
        })();
    });
    void app.whenReady().then(() => send({ type: "ready" })).catch(() => app.exit(1));
}
function compact(value: string): string { const text = value.replace(/\s+/g, " ").trim(); return text.length > 80 ? text.slice(0, 79) + "…" : text || "原文"; }
