import type Database from "better-sqlite3";
import { MAX_FUTURE_PUBLICATION_SKEW_MS } from "../../shared/publication-date";

/**
 * Persistent schema upgrades are deliberately kept out of the repository
 * implementation.  A database can therefore be opened, inspected and
 * upgraded without mixing DDL with source/content business operations.
 */
export const CURRENT_SCHEMA_VERSION = 4;

type SqliteDatabase = Database.Database;

type SchemaMigration = {
  version: number;
  name: string;
  up: (database: SqliteDatabase) => void;
};

/** Apply every missing, ordered migration in one transaction per version. */
export function migrateDatabaseSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version)
  );
  const latest = Math.max(0, ...applied);
  if (latest > CURRENT_SCHEMA_VERSION) {
    throw new Error(`本地数据库版本 ${latest} 比当前应用支持的版本 ${CURRENT_SCHEMA_VERSION} 更新。请先升级 Reading Hub。`);
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      migration.up(database);
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, Date.now());
    })();
  }
}

const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "create-core-reader-tables",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          icon_url TEXT,
          category TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          extraction_rule TEXT,
          metadata_revision INTEGER,
          polling_enabled INTEGER NOT NULL DEFAULT 1,
          refresh_interval_minutes INTEGER,
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
        CREATE TABLE IF NOT EXISTS entries (
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
        CREATE INDEX IF NOT EXISTS entries_timeline ON entries(is_read, published_at DESC, created_at DESC);
        CREATE TABLE IF NOT EXISTS followees (
          url_token TEXT PRIMARY KEY,
          fullname TEXT NOT NULL,
          url TEXT NOT NULL,
          avatar_url TEXT,
          headline TEXT,
          follower_count INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          subject_id TEXT,
          keychain_account TEXT,
          scopes_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          config_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS accounts_connector_subject ON accounts(connector_id, subject_id)
          WHERE subject_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
          connector_id TEXT NOT NULL,
          account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
          target_id TEXT,
          config_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS subscriptions_connector ON subscriptions(connector_id, account_id);
        CREATE TABLE IF NOT EXISTS sync_checkpoints (
          subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
          cursor TEXT,
          since_id TEXT,
          data_json TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entry_origins (
          entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          provider_label TEXT,
          external_id TEXT NOT NULL DEFAULT '',
          original_url TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (entry_id, source_id, provider_id, external_id)
        );
        CREATE INDEX IF NOT EXISTS entry_origins_source ON entry_origins(source_id, observed_at DESC);
        CREATE TABLE IF NOT EXISTS dismissed_contents (
          canonical_identity TEXT PRIMARY KEY,
          dismissed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_events (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          outcome TEXT NOT NULL,
          fetched_count INTEGER NOT NULL DEFAULT 0,
          inserted_count INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          created_at INTEGER NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: "upgrade-source-subscription-and-content-origins",
    up: (database) => {
      // SQLite does not support `ADD COLUMN IF NOT EXISTS`; the helper keeps
      // upgrades idempotent for databases created by every prior app build.
      ensureColumn(database, "sources", "connector_id", "TEXT");
      ensureColumn(database, "sources", "account_id", "TEXT");
      ensureColumn(database, "sources", "config_json", "TEXT");
      ensureColumn(database, "sources", "refresh_interval_minutes", "INTEGER");
      ensureColumn(database, "sources", "metadata_revision", "INTEGER");
      ensureColumn(database, "sources", "category", "TEXT");
      ensureColumn(database, "sources", "icon_url", "TEXT");
      ensureColumn(database, "entries", "observed_at", "INTEGER");
      ensureColumn(database, "entries", "provider_id", "TEXT");
      ensureColumn(database, "entries", "external_id", "TEXT");
      ensureColumn(database, "entries", "canonical_identity", "TEXT");
      ensureColumn(database, "entries", "provider_label", "TEXT");
      ensureColumn(database, "entry_origins", "provider_label", "TEXT");
      database.exec("CREATE INDEX IF NOT EXISTS entries_identity ON entries(canonical_identity)");
      database.exec("UPDATE sources SET connector_id = kind WHERE connector_id IS NULL OR connector_id = ''");
      database.exec("UPDATE entries SET observed_at = created_at WHERE observed_at IS NULL");
      database.exec("UPDATE entries SET provider_id = (SELECT connector_id FROM sources WHERE sources.id = entries.source_id) WHERE provider_id IS NULL");
      database.exec("UPDATE entries SET canonical_identity = canonical_url WHERE canonical_identity IS NULL");
      backfillSubscriptionsAndOrigins(database);
    }
  },
  {
    version: 3,
    name: "track-per-source-content-maintenance",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS source_maintenance (
          source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    }
  },
  {
    version: 4,
    name: "clear-unverified-future-publication-dates",
    up: (database) => {
      // Earlier builds trusted every source timestamp.  Retain affected
      // cards and their local observation time, but clear dates that cannot
      // represent already-published content so they do not sort as future.
      database.prepare("UPDATE entries SET published_at = NULL WHERE published_at > ?")
        .run(Date.now() + MAX_FUTURE_PUBLICATION_SKEW_MS);
    }
  }
];

function ensureColumn(database: SqliteDatabase, table: "sources" | "entries" | "entry_origins", column: string, type: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function backfillSubscriptionsAndOrigins(database: SqliteDatabase): void {
  const now = Date.now();
  const sources = database.prepare("SELECT id, kind, connector_id, account_id, config_json, created_at, updated_at FROM sources").all() as Array<{
    id: string;
    kind: string;
    connector_id: string | null;
    account_id: string | null;
    config_json: string | null;
    created_at: number;
    updated_at: number;
  }>;
  const insertSubscription = database.prepare(`INSERT OR IGNORE INTO subscriptions
    (id, source_id, connector_id, account_id, target_id, config_json, created_at, updated_at)
    VALUES (@id, @sourceId, @connectorId, @accountId, NULL, @configJson, @createdAt, @updatedAt)`);
  for (const source of sources) {
    insertSubscription.run({
      id: source.id,
      sourceId: source.id,
      connectorId: source.connector_id ?? source.kind,
      accountId: source.account_id,
      configJson: source.config_json,
      createdAt: source.created_at || now,
      updatedAt: source.updated_at || now
    });
  }
  database.exec(`INSERT OR IGNORE INTO entry_origins (entry_id, source_id, provider_id, provider_label, external_id, original_url, observed_at)
    SELECT id, source_id, COALESCE(provider_id, (SELECT connector_id FROM sources WHERE sources.id = entries.source_id), 'generic'),
      provider_label, COALESCE(external_id, ''), original_url, COALESCE(observed_at, created_at) FROM entries`);
}
