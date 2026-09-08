const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");

app.setPath("userData", path.join(tmpdir(), `reading-hub-ipc-smoke-${process.pid}`));
const watchdog = setTimeout(() => {
  console.error("Reading Hub IPC smoke timed out.");
  process.exit(1);
}, 30_000);

async function waitFor(check, description) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `Timed out: ${description}`);
    await delay(25);
  }
}

async function verify() {
  await app.whenReady();
  const { ReadingDatabase } = require("../../dist/main/main/database.js");
  const { registerIpcHandlers } = require("../../dist/main/main/ipc-handlers.js");
  const database = new ReadingDatabase(":memory:");
  const requests = [];
  const drain = registerIpcHandlers({ database, sources: {
    preview: (_url, signal) => new Promise((resolve) => { requests.push({ signal, resolve }); })
  } });
  const windows = [];
  const baselines = [];
  try {
    for (let index = 0; index < 2; index++) {
      const window = new BrowserWindow({ show: false, focusable: false, webPreferences: {
        preload: path.resolve(__dirname, "../../dist/main/main/preload.js"),
        sandbox: true, contextIsolation: true, nodeIntegration: false
      } });
      windows.push(window);
      await window.loadURL("about:blank");
      baselines.push(window.webContents.listenerCount("destroyed"));
      await window.webContents.executeJavaScript("globalThis.revisions = []; window.reader.onLibraryChanged(revision => revisions.push(revision)); window.reader.listSources()");
      await window.webContents.executeJavaScript("window.reader.listSources()");
      assert.equal(window.webContents.listenerCount("destroyed"), baselines[index] + 1);
    }
    const createSource = (name) => database.createSource({
      url: `https://example.com/${name}`, title: "IPC fixture", kind: "rss", pollingEnabled: true
    });
    createSource("first");
    for (const window of windows) {
      await waitFor(() => window.webContents.executeJavaScript("revisions.length === 1"), "first library revision");
    }
    for (const [index, window] of windows.entries()) {
      // Keep service work pending to verify that cancellation does not skip its cleanup.
      await window.webContents.executeJavaScript("globalThis.previewState = 'pending'; window.reader.previewSource('https://example.com/preview').then(() => { previewState = 'success'; }, () => { previewState = 'cancelled'; }); void 0");
      await waitFor(() => requests.length === index + 1, "foreground request registration");
      assert.equal(window.webContents.listenerCount("destroyed"), baselines[index] + 2);
    }
    const destroyed = new Promise((resolve) => windows[0].webContents.once("destroyed", resolve));
    windows[0].destroy();
    await destroyed;
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false, "Closing one window must not cancel another window's request.");
    createSource("second");
    await waitFor(() => windows[1].webContents.executeJavaScript("revisions.length === 2"), "surviving observer");
    let drained = false;
    const pendingDrain = drain().then(() => { drained = true; });
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(windows[1].webContents.listenerCount("destroyed"), baselines[1]);
    await delay(0);
    assert.equal(drained, false, "IPC drain must wait for already-started service work to settle.");
    for (const request of requests) request.resolve({});
    await pendingDrain;
    await waitFor(() => windows[1].webContents.executeJavaScript("previewState === 'cancelled'"), "late result cancellation");
    createSource("after-drain");
    assert.equal(await windows[1].webContents.executeJavaScript("revisions.length"), 2);
    const rejected = await windows[1].webContents.executeJavaScript("window.reader.previewSource('https://example.com/after-drain').then(() => false, () => true)");
    assert.equal(rejected, true, "Shutdown must stop accepting new IPC work.");
    assert.equal(requests.length, 2);
    console.log("Reading Hub IPC smoke: passed; real preload, observer deduplication, window destruction, request isolation, late result cancellation and shutdown drain.");
  } finally {
    for (const request of requests) request.resolve({});
    await drain();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    database.close();
  }
}

verify().then(() => { clearTimeout(watchdog); app.exit(0); }, (error) => {
  console.error("Reading Hub IPC smoke failed:", error);
  clearTimeout(watchdog);
  app.exit(1);
});
