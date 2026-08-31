import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { CURRENT_SCHEMA_VERSION } from "../src/main/persistence/schema";
import { MAX_FUTURE_PUBLICATION_SKEW_MS } from "../src/shared/publication-date";

describe("persistent schema migrations", () => {
  it("upgrades a pre-subscription database once without losing existing cards", () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-migration-"));
    const filePath = join(directory, "legacy.sqlite");
    let database: ReadingDatabase | undefined;
    let reopened: ReadingDatabase | undefined;
    try {
      createLegacyDatabase(filePath);

      database = new ReadingDatabase(filePath);
      expect(database.getSource("legacy-source")).toMatchObject({ connectorId: "rss" });
      expect(database.getSubscriptionForSource("legacy-source")).toMatchObject({
        id: "legacy-source",
        sourceId: "legacy-source",
        connectorId: "rss"
      });
      expect(database.listEntries()).toEqual(expect.arrayContaining([expect.objectContaining({
        id: "legacy-entry",
        observedAt: 1_700_000_000_000,
        providerId: "rss",
        canonicalIdentity: "https://example.com/posts/legacy"
      })]));
      expect(database.getEntry("future-entry")).toMatchObject({
        id: "future-entry",
        publishedAt: undefined,
        observedAt: 1_700_000_000_000
      });
      database.close();
      database = undefined;

      const firstOpen = inspectMigrationState(filePath);
      expect(firstOpen.versions).toEqual([1, 2, 3, 4]);
      expect(firstOpen.originCount).toBe(2);
      expect(firstOpen.hasSourceMaintenance).toBe(true);

      reopened = new ReadingDatabase(filePath);
      expect(reopened.listEntries()).toHaveLength(2);
      expect(reopened.getEntry("future-entry")?.publishedAt).toBeUndefined();
      expect(reopened.getSubscriptionForSource("legacy-source")).toBeDefined();
      reopened.close();
      reopened = undefined;

      expect(inspectMigrationState(filePath)).toEqual(firstOpen);
      expect(firstOpen.versions.at(-1)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      database?.close();
      reopened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createLegacyDatabase(filePath: string): void {
  const database = new Sqlite(filePath);
  database.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      extraction_rule TEXT,
      polling_enabled INTEGER NOT NULL DEFAULT 1,
      etag TEXT,
      last_modified TEXT,
      last_checked_at INTEGER,
      next_check_at INTEGER,
      consecutive_empty INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      canonical_url TEXT NOT NULL UNIQUE,
      original_url TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      published_at INTEGER,
      summary TEXT,
      image_url TEXT,
      content_hash TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  database.prepare(`INSERT INTO sources (
    id, url, title, kind, status, extraction_rule, polling_enabled, etag, last_modified,
    last_checked_at, next_check_at, consecutive_empty, failure_count, last_error, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, 1, NULL, NULL, NULL, NULL, 0, 0, NULL, ?, ?)`)
    .run("legacy-source", "https://example.com/feed.xml", "Legacy Feed", "rss", "active", 1_700_000_000_000, 1_700_000_000_000);
  database.prepare(`INSERT INTO entries (
    id, source_id, canonical_url, original_url, title, author, published_at, summary, image_url,
    content_hash, is_read, is_favorite, created_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 0, 0, ?)`)
    .run("legacy-entry", "legacy-source", "https://example.com/posts/legacy", "https://example.com/posts/legacy", "Legacy article", "legacy-hash", 1_700_000_000_000);
  database.prepare(`INSERT INTO entries (
    id, source_id, canonical_url, original_url, title, author, published_at, summary, image_url,
    content_hash, is_read, is_favorite, created_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, 0, 0, ?)`)
    .run(
      "future-entry",
      "legacy-source",
      "https://example.com/posts/future",
      "https://example.com/posts/future",
      "Incorrectly future-dated article",
      Date.now() + MAX_FUTURE_PUBLICATION_SKEW_MS + 60_000,
      "future-hash",
      1_700_000_000_000
    );
  database.close();
}

function inspectMigrationState(filePath: string): {
  versions: number[];
  originCount: number;
  hasSourceMaintenance: boolean;
} {
  const database = new Sqlite(filePath, { readonly: true });
  try {
    return {
      versions: (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version),
      originCount: (database.prepare("SELECT COUNT(*) AS count FROM entry_origins").get() as { count: number }).count,
      hasSourceMaintenance: Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_maintenance'").get())
    };
  } finally {
    database.close();
  }
}
