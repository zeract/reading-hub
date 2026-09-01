import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Account,
  AccountStatus,
  ConnectorId,
  ContentOrigin,
  Entry,
  EntryPage,
  EntryPageCursor,
  EntryPageQuery,
  EntryListQuery,
  Facet,
  FacetReference,
  Followee,
  LibraryCounts,
  Source,
  SourceCollectionSettings,
  SourceFacet,
  SourceInput,
  SourceSettings,
  SourceStatus,
  Subscription,
  SubscriptionScope,
  SyncCheckpoint
} from "../shared/types";
import { assertPublicUrl } from "../shared/url";
import { defaultSubscriptionScope, facetIdentity, normaliseFacetReference, normaliseFacets, normaliseSubscriptionScope } from "../shared/subscription-scope";
import {
  deletePromotedZhihuFollowEntries,
  deleteTaxonomyEntries,
  deleteUnsupportedZhihuFollowEntries,
  removeEntriesForSourceOrigins,
  repairGenericHomepageEntryUrls,
  repairScourRedirectEntries
} from "./persistence/legacy-content-repair";
import { migrateDatabaseSchema } from "./persistence/schema";

type SourceRow = {
  id: string;
  url: string;
  title: string;
  icon_url?: string | null;
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

type SubscriptionScopeRow = {
  subscription_id: string;
  history_mode: string;
  history_limit: number | null;
  updated_at: number;
};

type FacetRow = {
  id: string;
  scheme: string;
  facet_key: string;
  label: string;
};

type OriginRow = {
  entry_id: string;
  source_id: string;
  provider_id: ConnectorId;
  provider_label: string | null;
  external_id: string;
  original_url: string;
  observed_at: number;
};

type OriginFacetRow = FacetRow & {
  entry_id: string;
  source_id: string;
  provider_id: ConnectorId;
  external_id: string;
};

const toOptionalNumber = (value: number | null): number | undefined => (value === null ? undefined : value);

function finiteTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}

const DEFAULT_ENTRY_PAGE_SIZE = 100;
const MAX_ENTRY_PAGE_SIZE = 200;
const NULL_PUBLICATION_CURSOR_VALUE = Number.MIN_SAFE_INTEGER;
const ENTRY_PUBLICATION_GROUP = "CASE WHEN entries.published_at IS NULL THEN 1 ELSE 0 END";
const ENTRY_PUBLICATION_VALUE = `COALESCE(entries.published_at, ${NULL_PUBLICATION_CURSOR_VALUE})`;
const ENTRY_OBSERVED_VALUE = "COALESCE(entries.observed_at, entries.created_at)";
const ENTRY_ORDER_BY = `${ENTRY_PUBLICATION_GROUP} ASC, ${ENTRY_PUBLICATION_VALUE} DESC, ${ENTRY_OBSERVED_VALUE} DESC, entries.created_at DESC, entries.id DESC`;

function boundedPageSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ENTRY_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_ENTRY_PAGE_SIZE, Math.floor(value)));
}

function entryPageCursor(entry: Entry): EntryPageCursor {
  return {
    ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
    observedAt: entry.observedAt ?? entry.createdAt,
    createdAt: entry.createdAt,
    id: entry.id
  };
}

function afterEntryCursor(cursor: EntryPageCursor): { sql: string; parameters: Array<string | number> } {
  const publicationGroup = cursor.publishedAt === undefined ? 1 : 0;
  const publicationValue = cursor.publishedAt ?? NULL_PUBLICATION_CURSOR_VALUE;
  return {
    // The comparison is the exact inverse of ENTRY_ORDER_BY.  Keeping every
    // tie-breaker here makes continuation stable even when many old feed
    // items share a publication time or have no publication date at all.
    sql: `(
      ${ENTRY_PUBLICATION_GROUP} > ?
      OR (${ENTRY_PUBLICATION_GROUP} = ? AND (
        ${ENTRY_PUBLICATION_VALUE} < ?
        OR (${ENTRY_PUBLICATION_VALUE} = ? AND (
          ${ENTRY_OBSERVED_VALUE} < ?
          OR (${ENTRY_OBSERVED_VALUE} = ? AND (
            entries.created_at < ?
            OR (entries.created_at = ? AND entries.id < ?)
          ))
        ))
      ))
    )`,
    parameters: [
      publicationGroup,
      publicationGroup,
      publicationValue,
      publicationValue,
      cursor.observedAt,
      cursor.observedAt,
      cursor.createdAt,
      cursor.createdAt,
      cursor.id
    ]
  };
}

function originIdentity(origin: Pick<OriginRow, "entry_id" | "source_id" | "provider_id" | "external_id">): string {
  return `${origin.entry_id}\u0000${origin.source_id}\u0000${origin.provider_id}\u0000${origin.external_id}`;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
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
    iconUrl: row.icon_url ?? undefined,
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

function prepareFacetStatements(database: Database.Database) {
  return {
    upsert: database.prepare(`INSERT INTO facets (id, scheme, facet_key, label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scheme, facet_key) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`),
    findId: database.prepare("SELECT id FROM facets WHERE scheme = ? AND facet_key = ?")
  };
}

function persistFacet(
  statements: ReturnType<typeof prepareFacetStatements>,
  facet: Facet,
  now: number
): string {
  statements.upsert.run(randomUUID(), facet.scheme, facet.key, facet.label, now, now);
  const row = statements.findId.get(facet.scheme, facet.key) as { id: string } | undefined;
  if (!row) throw new Error("无法保存文章分类。");
  return row.id;
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

function facetFromRow(row: FacetRow): Facet {
  return { scheme: row.scheme, key: row.facet_key, label: row.label };
}

function subscriptionFromRow(row: SubscriptionRow, scope: SubscriptionScope = defaultSubscriptionScope()): Subscription {
  return {
    id: row.id,
    sourceId: row.source_id,
    connectorId: row.connector_id,
    accountId: row.account_id ?? undefined,
    targetId: row.target_id ?? undefined,
    config: parseJsonRecord(row.config_json) ?? {},
    scope,
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
    migrateDatabaseSchema(this.db);
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
    const subscription: Subscription = {
      id: source.id,
      sourceId: source.id,
      connectorId: source.connectorId ?? source.kind,
      accountId: source.accountId,
      targetId: typeof source.config?.targetId === "string" ? source.config.targetId : undefined,
      config: source.config ?? {},
      scope: defaultSubscriptionScope(),
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
    this.db.prepare(`INSERT OR IGNORE INTO subscription_scopes (subscription_id, history_mode, history_limit, updated_at)
      VALUES (?, 'none', NULL, ?)`).run(subscription.id, subscription.updatedAt);
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
    // SourceKind is a UI compatibility category, while connectorId identifies
    // the host-owned protocol implementation. Editing a title/category must
    // never silently switch a future connector back to the generic adapter.
    const connectorId = kindChanged ? settings.kind : source.connectorId ?? source.kind;
    const nextCheckAt = settings.pollingEnabled ? now + refreshDelay(settings.refreshIntervalMinutes) : null;
    const extractionRule = kindChanged && settings.kind !== "generic" ? null : source.extractionRule ? JSON.stringify(source.extractionRule) : null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE sources SET title = ?, category = ?, kind = ?, connector_id = ?, polling_enabled = ?, refresh_interval_minutes = ?,
        extraction_rule = ?, etag = CASE WHEN ? THEN NULL ELSE etag END, last_modified = CASE WHEN ? THEN NULL ELSE last_modified END,
        status = CASE WHEN ? OR (? AND status = 'paused') THEN 'active' ELSE status END,
        next_check_at = ?, updated_at = ? WHERE id = ?`)
        .run(settings.title, normaliseSourceCategory(settings.category) ?? null, settings.kind, connectorId, Number(settings.pollingEnabled), settings.refreshIntervalMinutes ?? null,
          extractionRule, Number(kindChanged), Number(kindChanged), Number(kindChanged), Number(settings.pollingEnabled), nextCheckAt, now, sourceId);
      if (kindChanged) {
        this.db.prepare("UPDATE subscriptions SET connector_id = ?, account_id = NULL, updated_at = ? WHERE source_id = ?")
          .run(settings.kind, now, sourceId);
        // Facet IDs are provider-scoped. Carrying a selected RSS category
        // into a different connector would silently filter all of its cards,
        // so a user-confirmed connector switch restores the conservative
        // current-Feed/no-selection policy.
        this.db.prepare(`INSERT OR IGNORE INTO subscription_scopes (subscription_id, history_mode, history_limit, updated_at)
          SELECT id, 'none', NULL, ? FROM subscriptions WHERE source_id = ?`).run(now, sourceId);
        this.db.prepare(`DELETE FROM subscription_scope_facets
          WHERE subscription_id IN (SELECT id FROM subscriptions WHERE source_id = ?)`)
          .run(sourceId);
        this.db.prepare(`UPDATE subscription_scopes SET history_mode = 'none', history_limit = NULL, updated_at = ?
          WHERE subscription_id IN (SELECT id FROM subscriptions WHERE source_id = ?)`)
          .run(now, sourceId);
        // A connector switch can expose cards collected by a different legacy
        // path. Let the source-scoped maintenance pass inspect it once again.
        this.db.prepare("DELETE FROM source_maintenance WHERE source_id = ?").run(sourceId);
      }
    })();
    return this.getSource(sourceId)!;
  }

  pauseSource(sourceId: string, reason: string): Source {
    const source = this.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    const now = Date.now();
    this.db.prepare(`UPDATE sources SET status = 'paused', polling_enabled = 0, next_check_at = NULL,
      last_error = ?, updated_at = ? WHERE id = ?`)
      .run(reason.slice(0, 300), now, sourceId);
    return this.getSource(sourceId)!;
  }

  /**
   * Repairs the legacy automatic-failure state machine. Earlier builds wrote
   * `paused + polling_enabled=1` after five transient failures, leaving a
   * source outside the scheduler forever. A genuine pause always disables
   * polling, so this only touches internally inconsistent legacy rows.
   */
  resumeLegacyAutoPausedSources(now = Date.now()): number {
    const sources = this.db.prepare(`SELECT id FROM sources
      WHERE status = 'paused' AND polling_enabled = 1 ORDER BY updated_at ASC`).all() as Array<{ id: string }>;
    const resume = this.db.prepare(`UPDATE sources SET status = 'error', next_check_at = ?, updated_at = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const source of sources) resume.run(now + legacyResumeJitter(source.id), now, source.id);
    })();
    return sources.length;
  }

  getSourceByUrl(url: string): Source | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE url = ?").get(url) as SourceRow | undefined;
    return row ? sourceFromRow(row) : undefined;
  }

  listSources(): Source[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY updated_at DESC").all() as SourceRow[]).map(sourceFromRow);
  }

  /** Internal maintenance state; never exposed over IPC or attached to a source. */
  getSourceMaintenanceRevision(sourceId: string): number | undefined {
    const row = this.db.prepare("SELECT revision FROM source_maintenance WHERE source_id = ?").get(sourceId) as { revision: number } | undefined;
    return row?.revision;
  }

  markSourceMaintenanceRevision(sourceId: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("维护版本必须是正整数。");
    this.db.prepare(`INSERT INTO source_maintenance (source_id, revision, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`)
      .run(sourceId, revision, Date.now());
  }

  getSubscriptionForSource(sourceId: string): Subscription | undefined {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE source_id = ?").get(sourceId) as SubscriptionRow | undefined;
    return row ? subscriptionFromRow(row, this.getSubscriptionScope(row.id)) : undefined;
  }

  /**
   * Safe, renderer-ready collection metadata. Local source folders remain on
   * `Source.category`; these facets describe only content attributed to this
   * source's connector origins.
   */
  getSourceCollectionSettings(sourceId: string): SourceCollectionSettings {
    const subscription = this.getSubscriptionForSource(sourceId);
    if (!subscription) throw new Error("来源不存在。");
    return { scope: subscription.scope, facets: this.listSourceFacets(sourceId) };
  }

  listSourceFacets(sourceId: string): SourceFacet[] {
    const rows = this.db.prepare(`SELECT facets.scheme, facets.facet_key, facets.label, COUNT(DISTINCT entry_origin_facets.entry_id) AS entry_count
      FROM entry_origin_facets
      INNER JOIN facets ON facets.id = entry_origin_facets.facet_id
      WHERE entry_origin_facets.source_id = ?
      GROUP BY facets.id, facets.scheme, facets.facet_key, facets.label
      ORDER BY entry_count DESC, facets.label COLLATE NOCASE ASC, facets.scheme ASC, facets.facet_key ASC`).all(sourceId) as Array<FacetRow & { entry_count: number }>;
    return rows.map((row) => ({ ...facetFromRow(row), sourceId, entryCount: row.entry_count }));
  }

  /**
   * Replaces the user-owned selection atomically while leaving opaque
   * connector configuration and source metadata untouched.
   */
  updateSubscriptionScope(sourceId: string, requestedScope: SubscriptionScope): Subscription {
    const subscription = this.getSubscriptionForSource(sourceId);
    if (!subscription) throw new Error("来源不存在。");
    const scope = normaliseSubscriptionScope(requestedScope);
    if (scope.history.mode === "selected" && !scope.facetSelections.length) {
      throw new Error("选择分类历史时至少选择一个分类。");
    }
    if (scope.history.mode === "all" && scope.facetSelections.length) {
      throw new Error("导入全部历史时不能同时筛选文章分类。");
    }
    const now = Date.now();
    const facetStatements = prepareFacetStatements(this.db);
    const insertScopeFacet = this.db.prepare("INSERT OR IGNORE INTO subscription_scope_facets (subscription_id, facet_id) VALUES (?, ?)");
    const clearScopeFacets = this.db.prepare("DELETE FROM subscription_scope_facets WHERE subscription_id = ?");
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO subscription_scopes (subscription_id, history_mode, history_limit, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET history_mode = excluded.history_mode,
          history_limit = excluded.history_limit, updated_at = excluded.updated_at`)
        .run(subscription.id, scope.history.mode, scope.history.limit ?? null, now);
      clearScopeFacets.run(subscription.id);
      for (const facet of scope.facetSelections) {
        insertScopeFacet.run(subscription.id, persistFacet(facetStatements, facet, now));
      }
    })();
    return this.getSubscriptionForSource(sourceId)!;
  }

  private getSubscriptionScope(subscriptionId: string): SubscriptionScope {
    const row = this.db.prepare("SELECT * FROM subscription_scopes WHERE subscription_id = ?").get(subscriptionId) as SubscriptionScopeRow | undefined;
    if (!row) return defaultSubscriptionScope();
    const facets = this.db.prepare(`SELECT facets.id, facets.scheme, facets.facet_key, facets.label
      FROM subscription_scope_facets
      INNER JOIN facets ON facets.id = subscription_scope_facets.facet_id
      WHERE subscription_scope_facets.subscription_id = ?
      ORDER BY facets.label COLLATE NOCASE ASC, facets.scheme ASC, facets.facet_key ASC`).all(subscriptionId) as FacetRow[];
    return normaliseSubscriptionScope({
      facetSelections: facets.map(facetFromRow),
      history: {
        mode: row.history_mode as SubscriptionScope["history"]["mode"],
        ...(row.history_limit === null ? {} : { limit: row.history_limit })
      }
    });
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
    const filter = this.entryFilter(query);
    if (!filter) return [];
    const { conditions, parameters } = filter;
    const limit = boundedLimit(query.limit);
    const statement = this.db.prepare(`SELECT id, source_id, canonical_url, original_url, title, author, published_at, summary,
      image_url, content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity
      FROM entries${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY ${ENTRY_ORDER_BY}${limit ? " LIMIT ?" : ""}`);
    if (limit) parameters.push(limit);
    const rows = statement.all(...parameters) as EntryRow[];
    return this.withOrigins(rows.map(entryFromRow));
  }

  /**
   * The renderer's timeline never asks SQLite to materialise an arbitrary
   * source history. It reads small, stable pages and offers an explicit
   * continuation, preserving responsiveness for large feeds without a hidden
   * 200-entry ceiling.
   */
  listEntryPage(query: EntryPageQuery = {}): EntryPage {
    const filter = this.entryFilter(query);
    if (!filter) return { entries: [] };
    const { conditions, parameters } = filter;
    if (query.cursor) {
      const cursor = afterEntryCursor(query.cursor);
      conditions.push(cursor.sql);
      parameters.push(...cursor.parameters);
    }
    const pageSize = boundedPageSize(query.pageSize);
    const rows = this.db.prepare(`SELECT id, source_id, canonical_url, original_url, title, author, published_at, summary,
      image_url, content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity
      FROM entries${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY ${ENTRY_ORDER_BY} LIMIT ?`)
      .all(...parameters, pageSize + 1) as EntryRow[];
    const pageRows = rows.slice(0, pageSize);
    const entries = this.withOrigins(pageRows.map(entryFromRow));
    const lastEntry = entries.at(-1);
    return {
      entries,
      ...(rows.length > pageSize && lastEntry ? { nextCursor: entryPageCursor(lastEntry) } : {})
    };
  }

  /** Shared filter compiler for bounded and legacy entry list reads. */
  private entryFilter(query: Omit<EntryListQuery, "limit">): { conditions: string[]; parameters: Array<string | number> } | undefined {
    const startAt = finiteTimestamp(query.startAt);
    const endAt = finiteTimestamp(query.endAt);
    if (startAt !== undefined && endAt !== undefined && endAt <= startAt) return undefined;

    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.sourceId) {
      conditions.push(`(entries.source_id = ? OR EXISTS (
        SELECT 1 FROM entry_origins WHERE entry_origins.entry_id = entries.id AND entry_origins.source_id = ?
      ))`);
      parameters.push(query.sourceId, query.sourceId);
    }
    // The renderer only exposes this as a source-local feature. Keep the
    // database boundary equally strict so an accidental future IPC caller
    // cannot turn a source search into an unbounded library-wide scan.
    if (query.search && !query.sourceId) return undefined;
    for (const term of entrySearchTerms(query.search)) {
      const pattern = `%${escapeLikePattern(term)}%`;
      conditions.push(`(
        entries.title LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR COALESCE(entries.author, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR COALESCE(entries.summary, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
      )`);
      parameters.push(pattern, pattern, pattern);
    }
    // Selecting a source means “show this subscription as configured”.  An
    // explicit empty array remains an escape hatch for maintenance/auditing
    // callers that deliberately need every retained origin.
    const implicitSelections = query.sourceId && query.facetSelections === undefined
      ? this.getSubscriptionForSource(query.sourceId)?.scope.facetSelections ?? []
      : query.facetSelections ?? [];
    const facetSelections = new Map<string, FacetReference>();
    for (const selection of implicitSelections) {
      const normalised = normaliseFacetReference(selection);
      if (normalised) facetSelections.set(facetIdentity(normalised), normalised);
    }
    if (facetSelections.size) {
      const selections = [...facetSelections.values()];
      const sameSource = query.sourceId ? " AND entry_origin_facets.source_id = ?" : "";
      const selectedFacetSql = selections.map(() => "(facets.scheme = ? AND facets.facet_key = ?)").join(" OR ");
      conditions.push(`EXISTS (
        SELECT 1 FROM entry_origin_facets
        INNER JOIN facets ON facets.id = entry_origin_facets.facet_id
        WHERE entry_origin_facets.entry_id = entries.id${sameSource}
          AND (${selectedFacetSql})
      )`);
      if (query.sourceId) parameters.push(query.sourceId);
      for (const selection of selections) parameters.push(selection.scheme, selection.key);
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
    if (query.read !== undefined) {
      conditions.push("entries.is_read = ?");
      parameters.push(query.read ? 1 : 0);
    }
    if (query.favorite !== undefined) {
      conditions.push("entries.is_favorite = ?");
      parameters.push(query.favorite ? 1 : 0);
    }
    return { conditions, parameters };
  }

  getLibraryCounts(now = Date.now()): LibraryCounts {
    const current = new Date(now);
    const start = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
    const end = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime();
    const timelineTimestamp = "COALESCE(published_at, observed_at, created_at)";
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN is_favorite = 1 THEN 1 ELSE 0 END) AS favorite,
      SUM(CASE WHEN ${timelineTimestamp} >= ? AND ${timelineTimestamp} < ? THEN 1 ELSE 0 END) AS today
      FROM entries`).get(start, end) as { unread: number | null; favorite: number | null; today: number | null };
    return { unread: row.unread ?? 0, favorite: row.favorite ?? 0, today: row.today ?? 0 };
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
    // Historical imports can contain thousands of cards. Fetch their origin
    // graph in bounded batches instead of issuing one query per entry (and a
    // second query for every origin). The batch size stays below SQLite's
    // conservative bind-variable limit while retaining the existing API.
    const originsByEntry = new Map<string, OriginRow[]>();
    const facetsByOrigin = new Map<string, Facet[]>();
    for (const entryIds of chunked(entries.map((entry) => entry.id), 400)) {
      const placeholders = entryIds.map(() => "?").join(", ");
      const origins = this.db.prepare(`SELECT entry_id, source_id, provider_id, provider_label, external_id, original_url, observed_at
        FROM entry_origins WHERE entry_id IN (${placeholders}) ORDER BY entry_id ASC, observed_at ASC`)
        .all(...entryIds) as OriginRow[];
      for (const origin of origins) {
        const entryOrigins = originsByEntry.get(origin.entry_id) ?? [];
        entryOrigins.push(origin);
        originsByEntry.set(origin.entry_id, entryOrigins);
      }
      const facetRows = this.db.prepare(`SELECT entry_origin_facets.entry_id, entry_origin_facets.source_id,
          entry_origin_facets.provider_id, entry_origin_facets.external_id, facets.id, facets.scheme, facets.facet_key, facets.label
        FROM entry_origin_facets
        INNER JOIN facets ON facets.id = entry_origin_facets.facet_id
        WHERE entry_origin_facets.entry_id IN (${placeholders})
        ORDER BY entry_origin_facets.entry_id ASC, entry_origin_facets.source_id ASC, entry_origin_facets.provider_id ASC,
          entry_origin_facets.external_id ASC, facets.label COLLATE NOCASE ASC, facets.scheme ASC, facets.facet_key ASC`)
        .all(...entryIds) as OriginFacetRow[];
      for (const row of facetRows) {
        const key = originIdentity(row);
        const facets = facetsByOrigin.get(key) ?? [];
        facets.push(facetFromRow(row));
        facetsByOrigin.set(key, facets);
      }
    }
    return entries.map((entry) => {
      const facetMap = new Map<string, Facet>();
      const origins = (originsByEntry.get(entry.id) ?? []).map((origin): ContentOrigin => {
        const facets = facetsByOrigin.get(originIdentity(origin)) ?? [];
        for (const facet of facets) facetMap.set(facetIdentity(facet), facet);
        return {
          sourceId: origin.source_id,
          providerId: origin.provider_id,
          providerLabel: origin.provider_label ?? undefined,
          externalId: origin.external_id || undefined,
          originalUrl: origin.original_url,
          observedAt: origin.observed_at,
          facets
        };
      });
      return { ...entry, facets: [...facetMap.values()], origins };
    });
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

  /** @deprecated ContentMaintenance owns legacy repair scheduling. */
  deleteTaxonomyEntries(sourceId: string): number {
    return deleteTaxonomyEntries(this.db, sourceId);
  }

  /** @deprecated ContentMaintenance owns legacy repair scheduling. */
  deleteUnsupportedZhihuFollowEntries(sourceId: string): number {
    return deleteUnsupportedZhihuFollowEntries(this.db, sourceId);
  }

  /** @deprecated ContentMaintenance owns legacy repair scheduling. */
  deletePromotedZhihuFollowEntries(sourceId: string): number {
    return deletePromotedZhihuFollowEntries(this.db, sourceId);
  }

  /** @deprecated ContentMaintenance owns legacy repair scheduling. */
  repairScourRedirectEntries(sourceId: string): number {
    return repairScourRedirectEntries(this.db, sourceId);
  }

  /** @deprecated ContentMaintenance owns legacy repair scheduling. */
  repairGenericHomepageEntryUrls(source: Source): number {
    return repairGenericHomepageEntryUrls(this.db, source);
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

  /**
   * Removes only legacy cards that are demonstrably feed-navigation links:
   * they have no publication time, body, summary or image and either point
   * back to the subscription endpoint or carry a social-network label. This
   * is deliberately narrower than pruning absent feed entries, since feeds
   * routinely paginate historical articles.
   */
  deleteNonContentFeedNavigationEntries(source: Pick<Source, "id" | "url">, removeDeclaredFeedHomepage = false): number {
    const candidates = this.db.prepare(`SELECT id, source_id, original_url, title, published_at, summary, image_url
      FROM entries WHERE source_id = ? AND published_at IS NULL`).all(source.id) as Array<{
      id: string;
      source_id: string;
      original_url: string;
      title: string;
      published_at: number | null;
      summary: string | null;
      image_url: string | null;
    }>;
    let sourceUrl: URL | undefined;
    try {
      sourceUrl = new URL(source.url);
    } catch {
      return 0;
    }
    const doomed = candidates.filter((entry) => {
      try {
        const url = new URL(entry.original_url);
        const emptyMetadata = !entry.summary?.trim() && !entry.image_url?.trim();
        if (url.origin === sourceUrl.origin && url.pathname === sourceUrl.pathname && url.search === sourceUrl.search) {
          return removeDeclaredFeedHomepage || emptyMetadata;
        }
        if (!emptyMetadata) return false;
        if (!/^(?:www\.)?(?:github|x|twitter|facebook|linkedin|instagram|youtube)\.com$/i.test(url.hostname)) return false;
        return /^(?:github|x(?:\s*\(@[^)]+\))?|twitter|facebook|linkedin|instagram|youtube)$/i.test(entry.title);
      } catch {
        return false;
      }
    });
    return removeEntriesForSourceOrigins(this.db, source.id, doomed);
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
    const facetStatements = prepareFacetStatements(this.db);
    const clearOriginFacets = this.db.prepare(`DELETE FROM entry_origin_facets
      WHERE entry_id = ? AND source_id = ? AND provider_id = ? AND external_id = ?`);
    const upsertOriginFacet = this.db.prepare(`INSERT OR IGNORE INTO entry_origin_facets
      (entry_id, source_id, provider_id, external_id, facet_id) VALUES (?, ?, ?, ?, ?)`);
    let inserted = 0;
    const transaction = this.db.transaction((records: Entry[]) => {
      for (const entry of records) {
        const identity = entry.canonicalIdentity ?? entry.canonicalUrl;
        if (isDismissed.get(identity)) continue;
        const isNew = !exists.get(entry.canonicalUrl);
        const providerId = entry.providerId ?? this.getSource(entry.sourceId)?.connectorId ?? "generic";
        const externalId = entry.externalId ?? "";
        const observedAt = entry.observedAt ?? entry.createdAt;
        insert.run({
          ...entry,
          author: entry.author ?? null,
          publishedAt: entry.publishedAt ?? null,
          summary: entry.summary ?? null,
          imageUrl: entry.imageUrl ?? null,
          observedAt,
          providerId,
          providerLabel: entry.providerLabel ?? null,
          externalId: entry.externalId ?? null,
          canonicalIdentity: identity
        });
        const stored = entryIdForCanonical.get(entry.canonicalUrl) as { id: string };
        upsertOrigin.run(
          stored.id,
          entry.sourceId,
          providerId,
          entry.providerLabel ?? null,
          externalId,
          entry.url,
          observedAt
        );
        // Undefined means the connector has no facet capability, not that an
        // existing source-origin taxonomy should be erased. An explicit empty
        // array is authoritative and clears stale facets for that origin.
        if (entry.facets !== undefined) {
          clearOriginFacets.run(stored.id, entry.sourceId, providerId, externalId);
          for (const facet of normaliseFacets(entry.facets)) {
            upsertOriginFacet.run(stored.id, entry.sourceId, providerId, externalId, persistFacet(facetStatements, facet, Date.now()));
          }
        }
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

  /** Stores only a public Feed-declared icon URL; image bytes remain in memory. */
  updateSourceIcon(sourceId: string, rawIconUrl: string | undefined): Source {
    if (!rawIconUrl) return this.getSource(sourceId)!;
    let iconUrl: string;
    try {
      iconUrl = assertPublicUrl(rawIconUrl).toString();
    } catch {
      return this.getSource(sourceId)!;
    }
    const source = this.getSource(sourceId);
    if (!source) throw new Error("来源不存在。");
    if (source.iconUrl === iconUrl) return source;
    this.db.prepare("UPDATE sources SET icon_url = ?, updated_at = ? WHERE id = ?").run(iconUrl, Date.now(), sourceId);
    return this.getSource(sourceId)!;
  }

  markFailure(source: Source, message: string): Source {
    const now = Date.now();
    const failures = source.failureCount + 1;
    this.db
      .prepare(`UPDATE sources SET status = ?, failure_count = ?, last_error = ?, last_checked_at = ?,
        next_check_at = ?, updated_at = ? WHERE id = ?`)
      // Network/parser failures remain retryable indefinitely. `paused` is
      // reserved for an explicit user or compliance stop through pauseSource,
      // which also disables polling.
      .run("error", failures, message.slice(0, 300), now, now + retryDelay(failures), now, source.id);
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

  close(): void {
    this.db.close();
  }
}

/**
 * Search remains deliberately small and local: each whitespace-separated
 * term must occur in one retained card field. SQLite parameters carry the
 * terms, while this helper only escapes LIKE's three pattern characters.
 */
function entrySearchTerms(search?: string): string[] {
  return search?.trim().split(/\s+/u).filter(Boolean) ?? [];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
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

/** Spread recovered legacy sources over a short window without using Math.random in persistence. */
function legacyResumeJitter(sourceId: string): number {
  let hash = 0;
  for (let index = 0; index < sourceId.length; index += 1) hash = (hash * 31 + sourceId.charCodeAt(index)) >>> 0;
  return hash % (15 * 60_000);
}
