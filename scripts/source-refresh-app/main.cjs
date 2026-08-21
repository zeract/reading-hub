const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { writeFile } = require("node:fs/promises");

// This maintenance command deliberately refreshes only ordinary public web
// sources. It invokes the same connector and SyncManager path as the UI, so
// robots, rate limits, source health, ETags and database deduplication remain
// owned by the application rather than a one-off script.
app.setPath("userData", path.join(tmpdir(), `reading-hub-source-refresh-${process.pid}`));

function sourceDatabasePath() {
  return process.env.READING_HUB_DB_PATH
    || path.join(app.getPath("appData"), "reading-hub", "reading-hub.sqlite");
}

function safeError(error) {
  return error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") : "未知错误";
}

async function run() {
  const { configureChromiumNetwork } = require("../../dist/main/main/network.js");
  const { ReadingDatabase } = require("../../dist/main/main/database.js");
  const { GenericConnector } = require("../../dist/main/main/connectors.js");
  const { ConnectorRegistry } = require("../../dist/main/main/connector-registry.js");
  const { PublicHttpClient } = require("../../dist/main/main/http.js");
  const { IsolatedPageRenderer } = require("../../dist/main/main/page-renderer.js");
  const { SyncManager } = require("../../dist/main/main/sync-manager.js");

  await configureChromiumNetwork();
  const database = new ReadingDatabase(sourceDatabasePath());
  const renderer = new IsolatedPageRenderer();
  const http = new PublicHttpClient();
  const generic = new GenericConnector(http, renderer);
  const registry = new ConnectorRegistry();
  // Use the same direct built-in adapter as the application. The adapter owns
  // its manifest, host contract and normalisation path, so this maintenance
  // command cannot silently drift from ordinary UI refresh behaviour.
  registry.register(generic);
  const sync = new SyncManager(database, registry);
  const sources = database.listSources().filter((source) => (source.connectorId || source.kind) === "generic" && source.pollingEnabled);
  const results = [];
  try {
    for (const source of sources) {
      try {
        const outcome = await sync.syncSource(source.id);
        const entries = database.listEntries(source.id, 500);
        results.push({
          source: source.title,
          status: "ok",
          inserted: outcome.inserted,
          entries: entries.length,
          withoutPublishedAt: entries.filter((entry) => entry.publishedAt === undefined).length
        });
      } catch (error) {
        results.push({ source: source.title, status: "failed", issue: safeError(error) });
      }
    }
    return { refreshedAt: new Date().toISOString(), sources: results };
  } finally {
    database.close();
  }
}

async function emitReport(report) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.READING_HUB_AUDIT_REPORT) await writeFile(process.env.READING_HUB_AUDIT_REPORT, output, "utf8");
  await new Promise((resolve) => process.stdout.write(output, resolve));
}

app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: false });
  try {
    await emitReport(await run());
  } catch (error) {
    await emitReport({ refreshError: safeError(error) });
    process.exitCode = 1;
  } finally {
    if (!host.isDestroyed()) host.destroy();
  }
}).finally(() => setTimeout(() => app.quit(), 25));
