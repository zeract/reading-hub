const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { writeFile } = require("node:fs/promises");
const Database = require("better-sqlite3");

// This script intentionally uses the same public HTTP client as the app. It
// is read-only: no source, checkpoint, card, cookie, or credential is changed.
app.setPath("userData", path.join(tmpdir(), `reading-hub-source-audit-${process.pid}`));

function safeError(error) {
  return error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") : "未知错误";
}

function sourceDatabasePath() {
  return process.env.READING_HUB_DB_PATH
    || path.join(app.getPath("appData"), "reading-hub", "reading-hub.sqlite");
}

function timestamp(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

function parseRule(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function inspectFeed(http, parseFeed, looksLikeFeed, feedUrl, allowTrustedLoopbackFeed = false) {
  const response = await http.getText(feedUrl, undefined, allowTrustedLoopbackFeed ? { allowTrustedLoopbackFeed: true } : undefined);
  if (!looksLikeFeed(response.contentType, response.text)) throw new Error("候选地址不是有效 Feed");
  const feed = await parseFeed(response.text, response.url);
  const newestPublishedAt = feed.entries.reduce((latest, entry) => Math.max(latest, entry.publishedAt || 0), 0);
  return {
    url: response.url,
    entries: feed.entries.length,
    newestPublishedAt: timestamp(newestPublishedAt || undefined)
  };
}

async function inspectSource(http, dependencies, source) {
  const rule = parseRule(source.extraction_rule);
  const config = parseRule(source.config_json);
  const configuredFeedUrl = typeof rule?.feedUrl === "string" ? rule.feedUrl : undefined;
  const allowTrustedLoopbackFeed = config?.allowTrustedLoopbackFeed === true;
  try {
    if (source.kind === "rss") {
      return {
        source: source.title,
        kind: source.kind,
        status: "ok",
        feed: await inspectFeed(http, dependencies.parseFeed, dependencies.looksLikeFeed, source.url, allowTrustedLoopbackFeed)
      };
    }

    const homepage = await http.getText(source.url);
    const candidates = [...new Set([configuredFeedUrl, ...dependencies.discoverFeedUrls(homepage.text, homepage.url)].filter(Boolean))];
    const candidateErrors = [];
    for (const candidate of candidates) {
      try {
        const feed = await inspectFeed(
          http,
          dependencies.parseFeed,
          dependencies.looksLikeFeed,
          candidate,
          allowTrustedLoopbackFeed && candidate === configuredFeedUrl
        );
        return {
          source: source.title,
          kind: source.kind,
          status: configuredFeedUrl ? "ok" : "upgrade-available",
          feed,
          // Do not emit arbitrary page HTML or source configuration.
          candidates: candidates.length
        };
      } catch (error) {
        candidateErrors.push(safeError(error));
      }
    }
    return {
      source: source.title,
      kind: source.kind,
      status: "no-feed",
      candidates: candidates.length,
      issue: candidateErrors[0]
    };
  } catch (error) {
    return { source: source.title, kind: source.kind, status: "unreachable", issue: safeError(error) };
  }
}

async function run() {
  const { configureChromiumNetwork } = require("../../dist/main/main/network.js");
  const { PublicHttpClient } = require("../../dist/main/main/http.js");
  const { discoverFeedUrls, looksLikeFeed, parseFeed } = require("../../dist/main/main/feed.js");
  await configureChromiumNetwork();

  const database = new Database(sourceDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    const sources = database.prepare(`SELECT title, url, kind, extraction_rule, config_json
      FROM sources WHERE kind IN ('rss', 'generic') AND polling_enabled = 1 ORDER BY title COLLATE NOCASE`).all();
    const http = new PublicHttpClient();
    const results = [];
    for (const source of sources) results.push(await inspectSource(http, { discoverFeedUrls, looksLikeFeed, parseFeed }, source));
    return { checkedAt: new Date().toISOString(), sources: results };
  } finally {
    database.close();
  }
}

async function emitReport(report) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.READING_HUB_AUDIT_REPORT) await writeFile(process.env.READING_HUB_AUDIT_REPORT, output, "utf8");
  // Electron can tear down a macOS console before console.log flushes. Write
  // directly and wait one turn before quitting so CI and local terminals see
  // the same report as the optional file output.
  await new Promise((resolve) => process.stdout.write(output, resolve));
}

app.whenReady().then(async () => {
  // macOS may end a windowless Electron process before asynchronous network
  // checks finish. Keep a hidden host alive just as the reader audit does.
  const host = new BrowserWindow({ show: false });
  try {
    await emitReport(await run());
  } finally {
    if (!host.isDestroyed()) host.destroy();
  }
}).catch(async (error) => {
  process.exitCode = 1;
  await emitReport({ auditError: safeError(error) });
}).finally(() => setTimeout(() => app.quit(), 25));
