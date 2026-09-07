import assert from "node:assert/strict";
import { BrowserWindow, session } from "electron";
import { guardMainFrameNavigation } from "../dist/main/main/navigation-policy.js";
import { assertPublicUrl } from "../dist/main/shared/url.js";

/** Synthetic HTTPS responses exercise Chromium navigation without network I/O. */
export async function verifyNavigationPolicy() {
  const isolated = session.fromPartition(`navigation-fixture-${process.pid}`);
  const requests = [];
  await isolated.protocol.handle("https", (request) => {
    requests.push(request.url);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/redirect-public" || pathname === "/redirect-private") {
      const destination = pathname === "/redirect-public"
        ? "https://navigation.fixture.invalid/final"
        : "https://127.0.0.1/private-fixture";
      return new Response(null, { status: 302, headers: { location: destination } });
    }
    return new Response("<!doctype html><title>Navigation fixture</title><p>Synthetic page</p>", {
      headers: { "content-type": "text/html" }
    });
  });
  const window = new BrowserWindow({ show: false, focusable: false, webPreferences: {
    session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true
  } });
  guardMainFrameNavigation(window.webContents, (url) => Boolean(assertPublicUrl(url)));
  try {
    await window.loadURL("https://navigation.fixture.invalid/redirect-public");
    assert.equal(window.webContents.getURL(), "https://navigation.fixture.invalid/final");
    let redirectBlocked = false;
    window.webContents.on("will-redirect", (event, url) => {
      if (url === "https://127.0.0.1/private-fixture") redirectBlocked = event.defaultPrevented;
    });
    await window.loadURL("https://navigation.fixture.invalid/redirect-private").catch(() => undefined);
    assert.equal(redirectBlocked, true, "Chromium must cancel a private redirect before following it.");
    assert(!requests.includes("https://127.0.0.1/private-fixture"));
    await window.loadURL("https://navigation.fixture.invalid/final");
    const navigation = new Promise((resolve) => window.webContents.once("will-navigate", (event) => resolve(event.defaultPrevented)));
    await window.webContents.executeJavaScript("location.href = 'https://127.0.0.1/private-fixture'; void 0");
    assert.equal(await navigation, true, "Script navigation must use the same document boundary.");
    assert(!requests.includes("https://127.0.0.1/private-fixture"));
  } finally {
    if (!window.isDestroyed()) window.destroy();
    isolated.protocol.unhandle("https");
    await isolated.clearStorageData();
  }
}
