import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Account,
  AccountStatus,
  ConnectorId,
  ContentOrigin,
  Entry,
  EntryListQuery,
  Followee,
  Source,
  SourceInput,
  SourceSettings,
  SourceStatus,
  Subscription,
  SyncCheckpoint
} from "../shared/types";

type SourceRow = {
  id: string;
  url: string;
  title: string;
  category?: string | null;
  kind: Source["kind"];
  status: SourceStatus;
  extraction_rule: string | null;
  polling_enabled: number;
  refresh_interval_minutes?: number | null;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: number | null;
  next_check_at: number | null;
  consecutive_empty: number;
  failure_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  connector_id?: ConnectorId | null;
  account_id?: string | null;
  config_json?: string | null;
  metadata_revision?: number | null;
};

type EntryRow = {
  id: string;
  source_id: string;
  canonical_url: string;
  original_url: string;
  title: string;
  author: string | null;
  published_at: number | null;
  summary: string | null;
  image_url: string | null;
  content_hash: string;
  is_read: number;
  is_favorite: number;
  created_at: number;
  observed_at?: number | null;
  provider_id?: ConnectorId | null;
  external_id?: string | null;
  canonical_identity?: string | null;
  provider_label?: string | null;
};

type AccountRow = {
  id: string;
  connector_id: ConnectorId;
  display_name: string;
  subject_id: string | null;
  keychain_account: string | null;
  scopes_json: string;
  status: AccountStatus;
  config_json: string | null;
  created_at: number;
  updated_at: number;
};

type SubscriptionRow = {
  id: string;
  source_id: string;
  connector_id: ConnectorId;
  account_id: string | null;
  target_id: string | null;
  config_json: string | null;
  created_at: number;
  updated_at: number;
};

const toOptionalNumber = (value: number | null): number | undefined => (value === null ? undefined : value);

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}

function normaliseSourceCategory(value: string | undefined): string | undefined {
  const category = value?.replace(/\s+/g, " ").trim();
  if (!category) return undefined;
  if (category.length > 60) throw new Error("来源分类最多 60 个字符。");
  return category;
}

function sourceFromRow(row: SourceRow): Source {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    category: row.category?.trim() || undefined,
    kind: row.kind,
    connectorId: row.connector_id ?? row.kind,
    accountId: row.account_id ?? undefined,
    config: parseJsonRecord(row.config_json),
    metadataRevision: toOptionalNumber(row.metadata_revision ?? null),
    status: row.status,
    extractionRule: row.extraction_rule ? JSON.parse(row.extraction_rule) : undefined,
    pollingEnabled: Boolean(row.polling_enabled),
    refreshIntervalMinutes: toOptionalNumber(row.refresh_interval_minutes ?? null),
    etag: row.etag ?? undefined,
    lastModified: row.last_modified ?? undefined,
    lastCheckedAt: toOptionalNumber(row.last_checked_at),
    nextCheckAt: toOptionalNumber(row.next_check_at),
    consecutiveEmpty: row.consecutive_empty,
    failureCount: row.failure_count,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function entryFromRow(row: EntryRow): Entry {
  return {
    id: row.id,
    sourceId: row.source_id,
    canonicalUrl: row.canonical_url,
    url: row.original_url,
    title: row.title,
    author: row.author ?? undefined,
    publishedAt: row.published_at ?? undefined,
    summary: row.summary ?? undefined,
    imageUrl: row.image_url ?? undefined,
    contentHash: row.content_hash,
    read: Boolean(row.is_read),
    favorite: Boolean(row.is_favorite),
    createdAt: row.created_at,
    observedAt: toOptionalNumber(row.observed_at ?? null),
    providerId: row.provider_id ?? undefined,
    providerLabel: row.provider_label ?? undefined,
    externalId: row.external_id ?? undefined,
    canonicalIdentity: row.canonical_identity ?? undefined
  };
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function accountFromRow(row: AccountRow): Account {
  return {
    id: row.id,
    connectorId: row.connector_id,
    displayName: row.display_name,
    subjectId: row.subject_id ?? undefined,
    keychainAccount: row.keychain_account ?? undefined,
    scopes: parseJsonArray(row.scopes_json),
    status: row.status,
    config: parseJsonRecord(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function subscriptionFromRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    sourceId: row.source_id,
    connectorId: row.connector_id,
    accountId: row.account_id ?? undefined,
    targetId: row.target_id ?? undefined,
    config: parseJsonRecord(row.config_json) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class ReadingDatabase {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
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
    // SQLite does not support `ADD COLUMN IF NOT EXISTS`; keep migrations
    // idempotent so an existing local reader upgrades in place.
    this.ensureColumn("sources", "connector_id", "TEXT");
    this.ensureColumn("sources", "account_id", "TEXT");
    this.ensureColumn("sources", "config_json", "TEXT");
    this.ensureColumn("sources", "refresh_interval_minutes", "INTEGER");
    this.ensureColumn("sources", "metadata_revision", "INTEGER");
    this.ensureColumn("sources", "category", "TEXT");
    this.ensureColumn("entries", "observed_at", "INTEGER");
    this.ensureColumn("entries", "provider_id", "TEXT");
    this.ensureColumn("entries", "external_id", "TEXT");
    this.ensureColumn("entries", "canonical_identity", "TEXT");
    this.ensureColumn("entries", "provider_label", "TEXT");
    this.ensureColumn("entry_origins", "provider_label", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS entries_identity ON entries(canonical_identity)");
    this.db.exec("UPDATE sources SET connector_id = kind WHERE connector_id IS NULL OR connector_id = ''");
    this.db.exec("UPDATE entries SET observed_at = created_at WHERE observed_at IS NULL");
    this.db.exec("UPDATE entries SET provider_id = (SELECT connector_id FROM sources WHERE sources.id = entries.source_id) WHERE provider_id IS NULL");
    this.db.exec("UPDATE entries SET canonical_identity = canonical_url WHERE canonical_identity IS NULL");
    this.migrateLegacySubscriptionsAndOrigins();
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private migrateLegacySubscriptionsAndOrigins(): void {
    const now = Date.now();
    const sources = this.db.prepare("SELECT id, kind, connector_id, account_id, config_json, created_at, updated_at FROM sources").all() as Array<{
      id: string; kind: ConnectorId; connector_id: ConnectorId | null; account_id: string | null; config_json: string | null; created_at: number; updated_at: number;
    }>;
    const insertSubscription = this.db.prepare(`INSERT OR IGNORE INTO subscriptions
      (id, source_id, connector_id, account_id, target_id, config_json, created_at, updated_at)
      VALUES (@id, @sourceId, @connectorId, @accountId, NULL, @configJson, @createdAt, @updatedAt)`);
    const transaction = this.db.transaction(() => {
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
      this.db.exec(`INSERT OR IGNORE INTO entry_origins (entry_id, source_id, provider_id, provider_label, external_id, original_url, observed_at)
        SELECT id, source_id, COALESCE(provider_id, (SELECT connector_id FROM sources WHERE sources.id = entries.source_id), 'generic'),
          provider_label, COALESCE(external_id, ''), original_url, COALESCE(observed_at, created_at) FROM entries`);
    });
    transaction();
  }

  createSource(input: SourceInput): Source {
    const now = Date.now();
    const source: Source = {
      id: randomUUID(),
      url: input.url,
      title: input.title,
      category: normaliseSourceCategory(input.category),
      kind: input.kind,
      connectorId: input.connectorId ?? input.kind,
      accountId: input.accountId,
      config: input.config,
      status: input.status ?? "active",
      extractionRule: input.extractionRule,
      pollingEnabled: input.pollingEnabled,
      refreshIntervalMinutes: input.refreshIntervalMinutes,
      nextCheckAt: input.pollingEnabled ? now : undefined,
      consecutiveEmpty: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(`INSERT INTO sources (
          id, url, title, category, kind, status, extraction_rule, polling_enabled, refresh_interval_minutes, next_check_at,
          consecutive_empty, failure_count, connector_id, account_id, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`)
      .run(
        source.id,
        source.url,
        source.title,
        source.category ?? null,
        source.kind,
        source.status,
        source.extractionRule ? JSON.stringify(source.extractionRule) : null,
        Number(source.pollingEnabled),
        source.refreshIntervalMinutes ?? null,
        source.nextCheckAt ?? null,
        source.connectorId,
        source.accountId ?? null,
        source.config ? JSON.stringify(source.config) : null,
        now,
        now
      );
    this.ensureSubscriptionForSource(source);
    return source;
  }

  private ensureSubscriptionForSource(source: Source): Subscription {
    const now = Date.now();
    const subscription: Subscription = {
      id: source.id,
      sourceId: source.id,
      connectorId: source.connectorId ?? source.kind,
      accountId: source.accountId,
      targetId: typeof source.config?.targetId === "string" ? source.config.targetId : undefined,
      config: source.config ?? {},
      createdAt: source.createdAt,
      updatedAt: source.updatedAt
    };
    this.db.prepare(`INSERT INTO subscriptions (id, source_id, connector_id, account_id, target_id, config_json, created_at, updated_at)
      VALUES (@id, @sourceId, @connectorId, @accountId, @targetId, @configJson, @createdAt, @updatedAt)
      ON CONFLICT(source_id) DO UPDATE SET connector_id = excluded.connector_id, account_id = excluded.account_id, target_id = excluded.target_id,
        config_json = excluded.config_json, updated_at = excluded.updated_at`).run({
      ...subscription,
      accountId: subscription.accountId ?? null,
      configJson: JSON.stringify(subscription.config)
    });
    return subscription;
  }

  getSource(id: string): Source | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
    return row ? sourceFromRow(row) : undefined;
  }

  updateSourceSettings(sourceId: string, settings: SourceSettings): Source {
    const source = this.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    const now = Date.now();
    const kindChanged = source.kind !== settings.kind;
    const nextCheckAt = settings.pollingEnabled ? now + refreshDelay(settings.refreshIntervalMinutes) : null;
    const extractionRule = kindChanged && settings.kind !== "generic" ? null : source.extractionRule ? JSON.stringify(source.extractionRule) : null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE sources SET title = ?, category = ?, kind = ?, connector_id = ?, polling_enabled = ?, refresh_interval_minutes = ?,
        extraction_rule = ?, etag = CASE WHEN ? THEN NULL ELSE etag END, last_modified = CASE WHEN ? THEN NULL ELSE last_modified END,
        status = CASE WHEN ? THEN 'active' ELSE status END, next_check_at = ?, updated_at = ? WHERE id = ?`)
        .run(settings.title, normaliseSourceCategory(settings.category) ?? null, settings.kind, settings.kind, Number(settings.pollingEnabled), settings.refreshIntervalMinutes ?? null,
          extractionRule, Number(kindChanged), Number(kindChanged), Number(kindChanged), nextCheckAt, now, sourceId);
      if (kindChanged) {
        this.db.prepare("UPDATE subscriptions SET connector_id = ?, account_id = NULL, updated_at = ? WHERE source_id = ?")
          .run(settings.kind, now, sourceId);
      }
    })();
    return this.getSource(sourceId)!;
  }

  getSourceByUrl(url: string): Source | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE url = ?").get(url) as SourceRow | undefined;
    return row ? sourceFromRow(row) : undefined;
  }

  listSources(): Source[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY updated_at DESC").all() as SourceRow[]).map(sourceFromRow);
  }

  getSubscriptionForSource(sourceId: string): Subscription | undefined {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE source_id = ?").get(sourceId) as SubscriptionRow | undefined;
    return row ? subscriptionFromRow(row) : undefined;
  }

  getCheckpoint(subscriptionId: string): SyncCheckpoint | undefined {
    const row = this.db.prepare("SELECT * FROM sync_checkpoints WHERE subscription_id = ?").get(subscriptionId) as {
      subscription_id: string; cursor: string | null; since_id: string | null; data_json: string | null; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      subscriptionId: row.subscription_id,
      cursor: row.cursor ?? undefined,
      sinceId: row.since_id ?? undefined,
      data: parseJsonRecord(row.data_json),
      updatedAt: row.updated_at
    };
  }

  saveCheckpoint(subscriptionId: string, checkpoint: Omit<SyncCheckpoint, "subscriptionId" | "updatedAt">): SyncCheckpoint {
    const now = Date.now();
    this.db.prepare(`INSERT INTO sync_checkpoints (subscription_id, cursor, since_id, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET cursor = excluded.cursor, since_id = excluded.since_id,
        data_json = excluded.data_json, updated_at = excluded.updated_at`)
      .run(subscriptionId, checkpoint.cursor ?? null, checkpoint.sinceId ?? null, checkpoint.data ? JSON.stringify(checkpoint.data) : null, now);
    return this.getCheckpoint(subscriptionId)!;
  }

  getAccount(id: string): Account | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? accountFromRow(row) : undefined;
  }

  listAccounts(connectorId?: ConnectorId): Account[] {
    const rows = connectorId
      ? this.db.prepare("SELECT * FROM accounts WHERE connector_id = ? ORDER BY updated_at DESC").all(connectorId)
      : this.db.prepare("SELECT * FROM accounts ORDER BY updated_at DESC").all();
    return (rows as AccountRow[]).map(accountFromRow);
  }

  findAccount(connectorId: ConnectorId, subjectId: string): Account | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE connector_id = ? AND subject_id = ?").get(connectorId, subjectId) as AccountRow | undefined;
    return row ? accountFromRow(row) : undefined;
  }

  saveAccount(input: Omit<Account, "id" | "createdAt" | "updatedAt"> & { id?: string }): Account {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO accounts (id, connector_id, display_name, subject_id, keychain_account, scopes_json, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, subject_id = excluded.subject_id,
        keychain_account = excluded.keychain_account, scopes_json = excluded.scopes_json, status = excluded.status,
        config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .run(id, input.connectorId, input.displayName, input.subjectId ?? null, input.keychainAccount ?? null,
        JSON.stringify(input.scopes), input.status, input.config ? JSON.stringify(input.config) : null, now, now);
    return this.getAccount(id)!;
  }

  updateAccountStatus(id: string, status: AccountStatus): void {
    this.db.prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  recordSyncEvent(sourceId: string, outcome: "success" | "failure" | "warning", fetchedCount = 0, insertedCount = 0, message?: string): void {
    this.db.prepare(`INSERT INTO sync_events (id, source_id, outcome, fetched_count, inserted_count, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), sourceId, outcome, fetchedCount, insertedCount, message?.slice(0, 300) ?? null, Date.now());
  }

  listSyncEvents(sourceId?: string, limit = 100): Array<{ sourceId: string; outcome: string; fetchedCount: number; insertedCount: number; message?: string; createdAt: number }> {
    const rows = sourceId
      ? this.db.prepare("SELECT source_id, outcome, fetched_count, inserted_count, message, created_at FROM sync_events WHERE source_id = ? ORDER BY created_at DESC LIMIT ?").all(sourceId, limit)
      : this.db.prepare("SELECT source_id, outcome, fetched_count, inserted_count, message, created_at FROM sync_events ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Array<any>).map((row) => ({
      sourceId: row.source_id,
      outcome: row.outcome,
      fetchedCount: row.fetched_count,
      insertedCount: row.inserted_count,
      message: row.message ?? undefined,
      createdAt: row.created_at
    }));
  }

  listDueSources(now = Date.now()): Source[] {
    return (
      this.db
        .prepare(`SELECT * FROM sources
          WHERE polling_enabled = 1 AND status IN ('active', 'error') AND next_check_at IS NOT NULL AND next_check_at <= ?
          ORDER BY next_check_at ASC`)
        .all(now) as SourceRow[]
    ).map(sourceFromRow);
  }

  listEntries(sourceId?: string, limit?: number): Entry[];
  listEntries(query?: EntryListQuery): Entry[];
  listEntries(sourceOrQuery?: string | EntryListQuery, legacyLimit = 200): Entry[] {
    const query: EntryListQuery = typeof sourceOrQuery === "string"
      ? { sourceId: sourceOrQuery, limit: legacyLimit }
      : sourceOrQuery ?? { limit: legacyLimit };
    const startAt = finiteTimestamp(query.startAt);
    const endAt = finiteTimestamp(query.endAt);
    if (startAt !== undefined && endAt !== undefined && endAt <= startAt) return [];

    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.sourceId) {
      conditions.push(`(entries.source_id = ? OR EXISTS (
        SELECT 1 FROM entry_origins WHERE entry_origins.entry_id = entries.id AND entry_origins.source_id = ?
      ))`);
      parameters.push(query.sourceId, query.sourceId);
    }
    // A missing publication time is deliberately represented by the first
    // observed time (then creation time) throughout the timeline.
    const timelineTimestamp = "COALESCE(entries.published_at, entries.observed_at, entries.created_at)";
    if (startAt !== undefined) {
      conditions.push(`${timelineTimestamp} >= ?`);
      parameters.push(startAt);
    }
    if (endAt !== undefined) {
      conditions.push(`${timelineTimestamp} < ?`);
      parameters.push(endAt);
    }
    const limit = boundedLimit(query.limit);
    const statement = this.db.prepare(`SELECT id, source_id, canonical_url, original_url, title, author, published_at, summary,
      image_url, content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity
      FROM entries${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY CASE WHEN published_at IS NULL THEN 1 ELSE 0 END ASC, published_at DESC, observed_at DESC, created_at DESC${limit ? " LIMIT ?" : ""}`);
    if (limit) parameters.push(limit);
    const rows = statement.all(...parameters) as EntryRow[];
    return this.withOrigins(rows.map(entryFromRow));
  }

  getEntry(entryId: string): Entry | undefined {
    const row = this.db
      .prepare(`SELECT id, source_id, canonical_url, original_url, title, author, published_at, summary,
        image_url, content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity FROM entries WHERE id = ?`)
      .get(entryId) as EntryRow | undefined;
    return row ? this.withOrigins([entryFromRow(row)])[0] : undefined;
  }

  private withOrigins(entries: Entry[]): Entry[] {
    if (!entries.length) return entries;
    const originQuery = this.db.prepare(`SELECT source_id, provider_id, provider_label, external_id, original_url, observed_at
      FROM entry_origins WHERE entry_id = ? ORDER BY observed_at ASC`);
    return entries.map((entry) => ({
      ...entry,
      origins: (originQuery.all(entry.id) as Array<any>).map((origin): ContentOrigin => ({
        sourceId: origin.source_id,
        providerId: origin.provider_id,
        providerLabel: origin.provider_label ?? undefined,
        externalId: origin.external_id || undefined,
        originalUrl: origin.original_url,
        observedAt: origin.observed_at
      }))
    }));
  }

  deleteSource(sourceId: string): void {
    const source = this.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    this.db.transaction(() => {
      this.removeSourceOrigins(sourceId);
      this.db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
      if (source.kind === "zhihu") this.db.prepare("DELETE FROM followees").run();
    })();
  }

  /**
   * Entries are user-level content, not source rows. Before a source is
   * removed, retain an item that is also attributed to a different source and
   * only delete content that no longer has any origin.
   */
  private removeSourceOrigins(sourceId: string): void {
    const affected = this.db.prepare("SELECT id, source_id FROM entries WHERE source_id = ? OR id IN (SELECT entry_id FROM entry_origins WHERE source_id = ?)")
      .all(sourceId, sourceId) as Array<{ id: string; source_id: string }>;
    const alternate = this.db.prepare("SELECT source_id FROM entry_origins WHERE entry_id = ? AND source_id != ? ORDER BY observed_at ASC LIMIT 1");
    const assign = this.db.prepare("UPDATE entries SET source_id = ? WHERE id = ?");
    for (const entry of affected) {
      const fallback = alternate.get(entry.id, sourceId) as { source_id: string } | undefined;
      if (entry.source_id === sourceId && fallback) assign.run(fallback.source_id, entry.id);
    }
    this.db.prepare("DELETE FROM entry_origins WHERE source_id = ?").run(sourceId);
    this.db.prepare("DELETE FROM entries WHERE NOT EXISTS (SELECT 1 FROM entry_origins WHERE entry_origins.entry_id = entries.id)").run();
  }

  deleteTaxonomyEntries(sourceId: string): number {
    const matches = this.db
      .prepare(`SELECT id, source_id FROM entries WHERE source_id = ? AND (
        original_url LIKE '%/tag/%' OR original_url LIKE '%/tags/%' OR
        original_url LIKE '%/category/%' OR original_url LIKE '%/categories/%' OR
        original_url LIKE '%/taxonomy/%' OR original_url LIKE '%/archive/%' OR original_url LIKE '%/archives/%'
      )`)
      .all(sourceId) as Array<{ id: string; source_id: string }>;
    if (!matches.length) return 0;
    const alternate = this.db.prepare("SELECT source_id FROM entry_origins WHERE entry_id = ? AND source_id != ? ORDER BY observed_at ASC LIMIT 1");
    const assign = this.db.prepare("UPDATE entries SET source_id = ? WHERE id = ?");
    const removeOrigin = this.db.prepare("DELETE FROM entry_origins WHERE entry_id = ? AND source_id = ?");
    const removeContent = this.db.prepare("DELETE FROM entries WHERE id = ? AND NOT EXISTS (SELECT 1 FROM entry_origins WHERE entry_origins.entry_id = entries.id)");
    this.db.transaction(() => {
      for (const entry of matches) {
        const fallback = alternate.get(entry.id, sourceId) as { source_id: string } | undefined;
        if (entry.source_id === sourceId && fallback) assign.run(fallback.source_id, entry.id);
        removeOrigin.run(entry.id, sourceId);
        removeContent.run(entry.id);
      }
    })();
    return matches.length;
  }

  /**
   * Remove a card from the reader and remember its stable content identity.
   * Active feeds often keep old items in their response, so a tombstone is
   * necessary to make a user deletion survive the next scheduled sync.
   */
  dismissEntry(entryId: string): void {
    const entry = this.db.prepare("SELECT canonical_identity, canonical_url FROM entries WHERE id = ?")
      .get(entryId) as { canonical_identity: string | null; canonical_url: string } | undefined;
    if (!entry) throw new Error("这篇内容已不存在。请刷新列表后重试。");
    const identity = entry.canonical_identity || entry.canonical_url;
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO dismissed_contents (canonical_identity, dismissed_at) VALUES (?, ?)")
        .run(identity, Date.now());
      this.db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
    })();
  }

  saveEntries(entries: Entry[]): number {
    const insert = this.db.prepare(`INSERT INTO entries (
      id, source_id, canonical_url, original_url, title, author, published_at, summary, image_url,
      content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity
    ) VALUES (@id, @sourceId, @canonicalUrl, @url, @title, @author, @publishedAt, @summary, @imageUrl,
      @contentHash, 0, 0, @createdAt, @observedAt, @providerId, @providerLabel, @externalId, @canonicalIdentity)
    ON CONFLICT(canonical_url) DO UPDATE SET
      title = excluded.title,
      author = COALESCE(excluded.author, entries.author),
      published_at = COALESCE(excluded.published_at, entries.published_at),
      summary = COALESCE(excluded.summary, entries.summary),
      image_url = COALESCE(excluded.image_url, entries.image_url),
      content_hash = excluded.content_hash,
      provider_id = COALESCE(excluded.provider_id, entries.provider_id),
      provider_label = COALESCE(excluded.provider_label, entries.provider_label),
      external_id = COALESCE(excluded.external_id, entries.external_id),
      canonical_identity = COALESCE(excluded.canonical_identity, entries.canonical_identity)`);
    const exists = this.db.prepare("SELECT 1 FROM entries WHERE canonical_url = ?");
    const isDismissed = this.db.prepare("SELECT 1 FROM dismissed_contents WHERE canonical_identity = ?");
    const entryIdForCanonical = this.db.prepare("SELECT id FROM entries WHERE canonical_url = ?");
    const upsertOrigin = this.db.prepare(`INSERT INTO entry_origins (entry_id, source_id, provider_id, provider_label, external_id, original_url, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id, source_id, provider_id, external_id) DO UPDATE SET
        provider_label = COALESCE(excluded.provider_label, entry_origins.provider_label), original_url = excluded.original_url, observed_at = excluded.observed_at`);
    let inserted = 0;
    const transaction = this.db.transaction((records: Entry[]) => {
      for (const entry of records) {
        const identity = entry.canonicalIdentity ?? entry.canonicalUrl;
        if (isDismissed.get(identity)) continue;
        const isNew = !exists.get(entry.canonicalUrl);
        insert.run({
          ...entry,
          author: entry.author ?? null,
          publishedAt: entry.publishedAt ?? null,
          summary: entry.summary ?? null,
          imageUrl: entry.imageUrl ?? null,
          observedAt: entry.observedAt ?? entry.createdAt,
          providerId: entry.providerId ?? this.getSource(entry.sourceId)?.connectorId ?? "generic",
          providerLabel: entry.providerLabel ?? null,
          externalId: entry.externalId ?? null,
          canonicalIdentity: identity
        });
        const stored = entryIdForCanonical.get(entry.canonicalUrl) as { id: string };
        upsertOrigin.run(
          stored.id,
          entry.sourceId,
          entry.providerId ?? this.getSource(entry.sourceId)?.connectorId ?? "generic",
          entry.providerLabel ?? null,
          entry.externalId ?? "",
          entry.url,
          entry.observedAt ?? entry.createdAt
        );
        if (isNew) inserted += 1;
      }
    });
    transaction(entries);
    return inserted;
  }

  markRead(entryId: string, read: boolean): void {
    this.db.prepare("UPDATE entries SET is_read = ? WHERE id = ?").run(Number(read), entryId);
  }

  markFavorite(entryId: string, favorite: boolean): void {
    this.db.prepare("UPDATE entries SET is_favorite = ? WHERE id = ?").run(Number(favorite), entryId);
  }

  markSuccess(source: Source, update: { etag?: string; lastModified?: string; empty?: boolean; requiresReview?: boolean }): Source {
    const now = Date.now();
    const emptyCount = update.empty ? source.consecutiveEmpty + 1 : 0;
    const requiresReview = update.requiresReview || (source.kind === "generic" && emptyCount >= 3);
    const status: SourceStatus = requiresReview ? "needs_review" : "active";
    const nextCheckAt = status === "active" && source.pollingEnabled ? now + refreshDelay(source.refreshIntervalMinutes) : null;
    this.db
      .prepare(`UPDATE sources SET status = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
        last_checked_at = ?, next_check_at = ?, consecutive_empty = ?, failure_count = 0, last_error = NULL,
        updated_at = ? WHERE id = ?`)
      .run(status, update.etag ?? null, update.lastModified ?? null, now, nextCheckAt, emptyCount, now, source.id);
    return this.getSource(source.id)!;
  }

  updateMetadataRevision(sourceId: string, metadataRevision: number): Source {
    this.db.prepare("UPDATE sources SET metadata_revision = ?, updated_at = ? WHERE id = ?")
      .run(metadataRevision, Date.now(), sourceId);
    return this.getSource(sourceId)!;
  }

  markFailure(source: Source, message: string): Source {
    const now = Date.now();
    const failures = source.failureCount + 1;
    const pause = failures >= 5;
    this.db
      .prepare(`UPDATE sources SET status = ?, failure_count = ?, last_error = ?, last_checked_at = ?,
        next_check_at = ?, updated_at = ? WHERE id = ?`)
      .run(pause ? "paused" : "error", failures, message.slice(0, 300), now, pause ? null : now + retryDelay(failures), now, source.id);
    this.recordSyncEvent(source.id, "failure", 0, 0, message);
    return this.getSource(source.id)!;
  }

  updateRule(sourceId: string, rule: Source["extractionRule"]): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE sources SET extraction_rule = ?, status = 'active', consecutive_empty = 0,
          next_check_at = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(rule), Date.now(), Date.now(), sourceId);
      // A rule correction replaces uncertain extraction output with a verified
      // replay, but it must not delete content still attributed to another source.
      this.removeSourceOrigins(sourceId);
    })();
  }

  /** Refresh an automatically repaired rule without discarding read state. */
  replaceAutomaticRule(sourceId: string, rule: Source["extractionRule"]): Source {
    const now = Date.now();
    this.db
      .prepare("UPDATE sources SET extraction_rule = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(rule), now, sourceId);
    return this.getSource(sourceId)!;
  }

  upsertFollowees(followees: Followee[]): void {
    const query = this.db.prepare(`INSERT INTO followees (url_token, fullname, url, avatar_url, headline, follower_count, updated_at)
      VALUES (@urlToken, @fullname, @url, @avatarUrl, @headline, @followerCount, @updatedAt)
      ON CONFLICT(url_token) DO UPDATE SET fullname = excluded.fullname, url = excluded.url,
        avatar_url = excluded.avatar_url, headline = excluded.headline, follower_count = excluded.follower_count,
        updated_at = excluded.updated_at`);
    this.db.transaction((items: Followee[]) => items.forEach((item) => query.run(item)))(followees);
  }

  listFollowees(): Followee[] {
    return this.db
      .prepare("SELECT url_token, fullname, url, avatar_url, headline, follower_count, updated_at FROM followees ORDER BY fullname COLLATE NOCASE")
      .all()
      .map((row: any) => ({
        urlToken: row.url_token,
        fullname: row.fullname,
        url: row.url,
        avatarUrl: row.avatar_url ?? undefined,
        headline: row.headline ?? undefined,
        followerCount: row.follower_count ?? undefined,
        updatedAt: row.updated_at
      }));
  }

  close(): void {
    this.db.close();
  }
}

export function randomRefreshDelay(): number {
  return (30 + Math.floor(Math.random() * 31)) * 60_000;
}

/** Keep a small jitter around user-selected cadence to avoid predictable bursts per domain. */
export function refreshDelay(intervalMinutes?: number): number {
  if (!intervalMinutes) return randomRefreshDelay();
  const jitter = Math.round(intervalMinutes * 0.1 * (Math.random() * 2 - 1));
  return Math.max(5, intervalMinutes + jitter) * 60_000;
}

export function retryDelay(failures: number): number {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, failures - 1));
}
