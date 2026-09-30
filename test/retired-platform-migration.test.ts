import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { sourceCapabilities } from "../src/shared/source-capabilities";

describe("retired platform source migration", () => {
  it.each(["x", "xiaohongshu"])("retains %s cards and user state across upgrade and restart", (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-retired-"));
    const file = join(directory, "library.sqlite");
    let db = new ReadingDatabase(file);
    try {
      const account = db.saveAccount({ connectorId: kind, displayName: "Legacy", keychainAccount: `${kind}:fixture`, scopes: [], status: "expired" });
      const source = db.createSource({ url: "https://example.com/legacy", title: "Legacy author", category: "My folder", kind: "manual", pollingEnabled: false });
      const rsshub = db.createSource({ url: "http://127.0.0.1:1200/twitter/user/fixture", title: "RSSHub", kind: "rss", pollingEnabled: true,
        config: { allowTrustedLoopbackFeed: true, sourceProvider: "rsshub", rsshubPlatform: "twitter" } });
      const manual = db.createSource({ url: "https://example.com/saved", title: "Saved", kind: "manual", pollingEnabled: false, config: { untouched: true } });
      db.saveEntries([{ id: "retained", sourceId: source.id, canonicalUrl: "https://example.com/post", url: "https://example.com/post", title: "Retained post",
        providerId: kind, canonicalIdentity: `${kind}:123`, contentHash: "saved-metadata", publishedAt: 100, createdAt: 200, observedAt: 200, read: false, favorite: false }]);
      db.markRead("retained", true); db.markFavorite("retained", true);
      db.saveCheckpoint(source.id, { sinceId: "123", data: { fixture: true } });
      db.saveCheckpoint(rsshub.id, { sinceId: "rss-kept" });
      const entriesBefore = db.listEntries();
      const originsBefore = db.listEntries()[0].origins;
      const rssBefore = db.getSource(rsshub.id);
      const manualBefore = db.getSubscriptionForSource(manual.id);
      db.close();
      const legacy = new Sqlite(file);
      legacy.prepare("UPDATE sources SET kind = ?, connector_id = ?, account_id = ?, polling_enabled = 1, status = 'error', next_check_at = 1, config_json = ?, last_error = 'obsolete' WHERE id = ?")
        .run(kind, kind, account.id, JSON.stringify({ mode: "profile" }), source.id);
      legacy.prepare("UPDATE subscriptions SET connector_id = ?, account_id = ?, config_json = ? WHERE source_id = ?")
        .run(kind, account.id, JSON.stringify({ mode: "profile" }), source.id);
      legacy.prepare("INSERT INTO article_rewrites(entry_id, job_id, status, settings_json, updated_at, result_json) VALUES ('retained', 'fixture-job', 'complete', '{}', 200, ?)")
        .run('{"fixture":"unchanged derived document"}');
      legacy.exec("DELETE FROM schema_migrations WHERE version = 18");
      legacy.close();

      for (let restart = 0; restart < 2; restart++) {
        db = new ReadingDatabase(file);
        const upgraded = db.getSource(source.id)!;
        expect(upgraded).toMatchObject({ title: source.title, category: source.category, kind: "manual", connectorId: "manual", status: "paused", pollingEnabled: false,
          accountId: undefined, config: undefined, nextCheckAt: undefined, lastError: undefined });
        expect(sourceCapabilities(upgraded).canRefresh).toBe(false);
        expect(db.getSubscriptionForSource(source.id)).toMatchObject({ connectorId: "manual", accountId: undefined, config: {} });
        expect(db.getCheckpoint(source.id)).toMatchObject({ cursor: undefined, sinceId: undefined, data: undefined });
        expect(db.getCheckpoint(rsshub.id)).toMatchObject({ sinceId: "rss-kept" });
        expect(db.getSource(rsshub.id)).toEqual(rssBefore);
        expect(db.getSubscriptionForSource(manual.id)).toEqual(manualBefore);
        expect(db.listEntries()).toEqual(entriesBefore);
        expect(db.listEntries()[0].origins).toEqual(originsBefore);
        expect(db.listDueSources()).not.toContainEqual(expect.objectContaining({ id: source.id }));
        expect(db.getAccount(account.id)?.keychainAccount).toBe(`${kind}:fixture`);
        db.close();
      }
      const stored = new Sqlite(file, { readonly: true });
      try {
        expect(stored.prepare("SELECT result_json FROM article_rewrites WHERE entry_id = 'retained'").get()).toEqual({ result_json: '{"fixture":"unchanged derived document"}' });
      } finally { stored.close(); }
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not remove an account still bound to an active source", () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const account = db.saveAccount({ connectorId: "academic", displayName: "Fixture", scopes: [], status: "active" });
      const source = db.createSource({ url: "https://academic.local/author/one", title: "Fixture", kind: "academic", accountId: account.id, pollingEnabled: true });
      expect(() => db.deleteAccount(account.id)).toThrow("仍被来源引用");
      expect(db.getAccount(account.id)).toBeDefined();
      db.deleteSource(source.id); db.deleteAccount(account.id);
      expect(db.getAccount(account.id)).toBeUndefined();
    } finally { db.close(); }
  });
});
