import Database from "better-sqlite3";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CURRENT_SCHEMA_VERSION, migrateDatabaseSchema } from "./persistence/schema";

export const LIBRARY_FILE_NAME = "reading-hub.sqlite";
export const DATA_LOCATION_MIGRATION_VERSION = 1;

type LibraryCounts = {
  sources: number;
  entries: number;
  unread: number;
  favorites: number;
  accounts: number;
  rewrites: number;
  userStateRows: number;
};

type ValidLibrary = LibraryInspection & {
  state: "valid";
  schemaVersion: number;
  counts: LibraryCounts;
};

export type LibraryInspection = {
  path: string;
  state: "missing" | "valid" | "invalid" | "future";
  schemaVersion?: number;
  counts?: LibraryCounts;
  issue?: string;
};

type MigrationRecord = {
  version: number;
  migrationId: string;
  status: "prepared" | "completed";
  createdAt: number;
  completedAt?: number;
  sourcePath: string;
  canonicalPath: string;
  backupPath: string;
  canonicalBackupPath?: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  sourceCounts: LibraryCounts;
  targetCounts?: LibraryCounts;
  sourceFingerprint: string;
  sourceLocatorHash: string;
  sessionStorage: "not-migrated";
};

type DataLocationMarker = {
  migrationId: string;
  sourceFingerprint: string;
  sourceLocatorHash: string;
};

type CanonicalReplacementBackup = {
  backupPath?: string;
  inspection: LibraryInspection;
  fingerprint?: string;
};

class CompetingCanonicalLibraryError extends Error {
  constructor(readonly canonical: LibraryInspection) {
    super("当前资料库在历史库接管期间获得了用户数据。");
  }
}

export type DataLocationResolution =
  | {
    kind: "fresh";
    databasePath: string;
    canonicalDirectory: string;
  }
  | {
    kind: "canonical";
    databasePath: string;
    canonicalDirectory: string;
    migrationBackupPath?: string;
    legacyLibraries: readonly LibraryInspection[];
  }
  | {
    kind: "migrated";
    databasePath: string;
    canonicalDirectory: string;
    backupPath: string;
    metadataPath: string;
    source: LibraryInspection;
  }
  | {
    kind: "ambiguous";
    databasePath: string;
    canonicalDirectory: string;
    canonical: LibraryInspection;
    legacyLibraries: readonly LibraryInspection[];
    message: string;
  }
  | {
    kind: "blocked";
    databasePath: string;
    canonicalDirectory: string;
    libraries: readonly LibraryInspection[];
    message: string;
  };

export type DataLocationResolverOptions = {
  canonicalDirectory: string;
  legacyDirectories: readonly string[];
  libraryFileName?: string;
  now?: () => number;
};

/**
 * Resolves the durable app library before any services, Chromium partitions or
 * scheduled maintenance are created. Only caller-provided historic roots are
 * inspected; this deliberately never searches arbitrary user directories.
 */
export async function resolveDataLocation(options: DataLocationResolverOptions): Promise<DataLocationResolution> {
  const libraryFileName = options.libraryFileName ?? LIBRARY_FILE_NAME;
  const canonicalDirectory = resolve(options.canonicalDirectory);
  const canonicalPath = join(canonicalDirectory, libraryFileName);
  const now = options.now ?? Date.now;
  const canonical = await inspectLibrary(canonicalPath);
  const legacyLibraries = await inspectLegacyLibraries(options.legacyDirectories, canonicalDirectory, libraryFileName);
  const usableLegacy = legacyLibraries.filter(isValidLibrary);
  const acknowledgedLegacyPaths = isValidLibrary(canonical) && isNonEmpty(canonical.counts)
    ? await acknowledgeCompletedLegacyLibraries(canonical, canonicalPath, usableLegacy, canonicalDirectory, now)
    : new Set<string>();
  const pendingLegacy = usableLegacy.filter((library) => !acknowledgedLegacyPaths.has(library.path));
  const blockedLegacy = legacyLibraries.filter((library) => library.state === "invalid" || library.state === "future");

  if (canonical.state === "future" || canonical.state === "invalid") {
    return blocked(canonicalPath, canonicalDirectory, [canonical, ...legacyLibraries], "当前资料库无法安全打开；不会创建空库覆盖已有数据。");
  }

  if (blockedLegacy.length) {
    return blocked(canonicalPath, canonicalDirectory, [canonical, ...legacyLibraries], "发现无法验证的历史资料库；不会创建空库掩盖它。请保留原目录并先恢复该资料库。");
  }

  if (isValidLibrary(canonical) && isNonEmpty(canonical.counts)) {
    if (pendingLegacy.some((library) => isNonEmpty(library.counts))) {
      return {
        kind: "ambiguous",
        databasePath: canonicalPath,
        canonicalDirectory,
        canonical,
        legacyLibraries,
        message: "发现两份非空的 Reading Hub 资料库。为避免自动合并或覆盖，应用没有选择其中任一份。"
      };
    }
    return {
      kind: "canonical",
      databasePath: canonicalPath,
      canonicalDirectory,
      migrationBackupPath: await backupBeforeSchemaUpgrade(canonical, canonicalDirectory, now),
      legacyLibraries
    };
  }

  const nonEmptyLegacy = pendingLegacy.filter((library) => isNonEmpty(library.counts));
  if (nonEmptyLegacy.length > 1) {
    return {
      kind: "ambiguous",
      databasePath: canonicalPath,
      canonicalDirectory,
      canonical,
      legacyLibraries,
      message: "发现多份非空的历史 Reading Hub 资料库。为避免自动合并或覆盖，应用没有进行迁移。"
    };
  }
  if (nonEmptyLegacy.length === 1) {
    return migrateLegacyLibrary(nonEmptyLegacy[0], canonical, canonicalDirectory, canonicalPath, libraryFileName, now);
  }

  if (isValidLibrary(canonical)) {
    return {
      kind: "canonical",
      databasePath: canonicalPath,
      canonicalDirectory,
      migrationBackupPath: await backupBeforeSchemaUpgrade(canonical, canonicalDirectory, now),
      legacyLibraries
    };
  }
  return { kind: "fresh", databasePath: canonicalPath, canonicalDirectory };
}

async function inspectLegacyLibraries(directories: readonly string[], canonicalDirectory: string, libraryFileName: string): Promise<LibraryInspection[]> {
  const candidates = [...new Set(directories.map((directory) => resolve(directory)))].filter((directory) => directory !== canonicalDirectory);
  return Promise.all(candidates.map((directory) => inspectLibrary(join(directory, libraryFileName))));
}

/**
 * A successful takeover intentionally leaves the old root untouched. On later
 * starts, recognize that exact immutable source snapshot only when the active
 * database itself carries a matching origin marker. A sidecar JSON record is
 * diagnostic evidence, not enough to hide a separate historical library.
 * Any source, marker or record mismatch returns the safe ambiguous result.
 */
async function acknowledgeCompletedLegacyLibraries(
  canonical: ValidLibrary,
  canonicalPath: string,
  legacyLibraries: readonly ValidLibrary[],
  canonicalDirectory: string,
  now: () => number
): Promise<Set<string>> {
  const records = await readMigrationRecords(canonicalDirectory, canonicalPath);
  const markers = readDataLocationMarkers(canonical.path);
  const acknowledged = new Set<string>();
  for (const legacy of legacyLibraries) {
    let fingerprint: string;
    try {
      fingerprint = fingerprintLibrary(legacy.path);
    } catch {
      // The source changed or disappeared after the read-only preflight. Do
      // not acknowledge it; the caller will keep the safe ambiguous path.
      continue;
    }
    const sourceLocatorHash = hashSourceLocator(legacy.path);
    const marker = markers.find((candidate) => candidate.sourceFingerprint === fingerprint && candidate.sourceLocatorHash === sourceLocatorHash);
    if (!marker) continue;
    const matching = records.find(({ record }) => record.migrationId === marker.migrationId
      && record.sourcePath === legacy.path
      && record.sourceFingerprint === marker.sourceFingerprint
      && record.sourceLocatorHash === marker.sourceLocatorHash);
    if (!matching) continue;
    if (matching.record.status === "prepared") {
      try {
        matching.record.status = "completed";
        matching.record.completedAt = now();
        await writeMigrationRecord(matching.path, matching.record);
      } catch {
        // Keep the prepared record for a later safe recovery attempt.
      }
    }
    if (matching.record.status === "completed") acknowledged.add(legacy.path);
  }
  return acknowledged;
}

function readDataLocationMarkers(filePath: string): DataLocationMarker[] {
  let database: Database.Database | undefined;
  try {
    database = new Database(filePath, { readonly: true, fileMustExist: true });
    if (!hasTable(database, "data_location_migrations")) return [];
    return (database.prepare(`SELECT migration_id, source_fingerprint, source_locator_hash
      FROM data_location_migrations`).all() as Array<{
        migration_id: unknown;
        source_fingerprint: unknown;
        source_locator_hash: unknown;
      }>)
      .filter((row) => typeof row.migration_id === "string"
        && isSha256(row.source_fingerprint)
        && isSha256(row.source_locator_hash))
      .map((row) => ({
        migrationId: row.migration_id as string,
        sourceFingerprint: row.source_fingerprint as string,
        sourceLocatorHash: row.source_locator_hash as string
      }));
  } catch {
    // A marker we cannot read must not acknowledge a legacy database.
    return [];
  } finally {
    database?.close();
  }
}

async function readMigrationRecords(canonicalDirectory: string, canonicalPath: string): Promise<Array<{ path: string; record: MigrationRecord }>> {
  const records: Array<{ path: string; record: MigrationRecord }> = [];
  const backupsDirectory = join(canonicalDirectory, "backups");
  let names: string[];
  try {
    names = await readdir(backupsDirectory);
  } catch (error) {
    if (isMissing(error)) return records;
    return records;
  }
  for (const name of names) {
    if (!/^data-migration-.*\.json$/.test(name)) continue;
    const path = join(backupsDirectory, name);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as Partial<MigrationRecord>;
      if (!isMigrationRecord(record, canonicalPath)) continue;
      records.push({ path, record });
    } catch {
      // A malformed diagnostic record must not mutate or hide any database.
    }
  }
  return records;
}

function isMigrationRecord(record: Partial<MigrationRecord>, canonicalPath: string): record is MigrationRecord {
  return record.version === DATA_LOCATION_MIGRATION_VERSION
    && (record.status === "prepared" || record.status === "completed")
    && record.canonicalPath === canonicalPath
    && typeof record.sourcePath === "string"
    && typeof record.backupPath === "string"
    && typeof record.migrationId === "string"
    && isSha256(record.sourceFingerprint)
    && isSha256(record.sourceLocatorHash)
    && typeof record.sourceSchemaVersion === "number"
    && typeof record.targetSchemaVersion === "number"
    && isLibraryCounts(record.sourceCounts);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isLibraryCounts(value: unknown): value is LibraryCounts {
  return Boolean(value && typeof value === "object" && ["sources", "entries", "unread", "favorites", "accounts", "rewrites", "userStateRows"]
    .every((key) => typeof (value as Record<string, unknown>)[key] === "number"));
}

/** Opens a database read-only, without creating it or applying a migration. */
export async function inspectLibrary(filePath: string): Promise<LibraryInspection> {
  try {
    await stat(filePath);
  } catch (error) {
    if (isMissing(error)) return { path: filePath, state: "missing" };
    return { path: filePath, state: "invalid", issue: "无法读取资料库文件。" };
  }

  let database: Database.Database | undefined;
  try {
    database = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check?: string }>;
    if (!integrity.every((row) => row.integrity_check === "ok")) {
      return { path: filePath, state: "invalid", issue: "SQLite 完整性检查失败。" };
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length) {
      return { path: filePath, state: "invalid", issue: "资料库存在外键一致性错误。" };
    }
    if (!hasTable(database, "sources") || !hasTable(database, "entries")) {
      return { path: filePath, state: "invalid", issue: "该文件不是 Reading Hub 资料库。" };
    }
    const schema = readSchemaVersion(database);
    if (!schema.valid) return { path: filePath, state: "invalid", issue: "资料库的迁移记录不连续，无法安全升级。" };
    const schemaVersion = schema.version;
    if (schemaVersion >= 17 && !hasTable(database, "data_location_migrations")) {
      return { path: filePath, state: "invalid", issue: "资料库缺少与其版本对应的迁移来源标记表。" };
    }
    const counts = readCounts(database);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      return { path: filePath, state: "future", schemaVersion, counts, issue: "资料库版本比当前应用更新。" };
    }
    return { path: filePath, state: "valid", schemaVersion, counts };
  } catch {
    return { path: filePath, state: "invalid", issue: "无法安全打开 SQLite 资料库。" };
  } finally {
    database?.close();
  }
}

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function readSchemaVersion(database: Database.Database): { version: number; valid: boolean } {
  if (!hasTable(database, "schema_migrations")) return { version: 0, valid: true };
  const versions = (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown }>)
    .map(({ version }) => Number(version));
  if (versions.some((version, index) => !Number.isInteger(version) || version < 1 || version !== index + 1)) {
    return { version: 0, valid: false };
  }
  return { version: versions.at(-1) ?? 0, valid: true };
}

function count(database: Database.Database, query: string): number {
  return Number((database.prepare(query).get() as { count: number }).count);
}

function readCounts(database: Database.Database): LibraryCounts {
  const entries = count(database, "SELECT COUNT(*) AS count FROM entries");
  return {
    sources: count(database, "SELECT COUNT(*) AS count FROM sources"),
    entries,
    unread: count(database, "SELECT COUNT(*) AS count FROM entries WHERE is_read = 0"),
    favorites: count(database, "SELECT COUNT(*) AS count FROM entries WHERE is_favorite = 1"),
    accounts: hasTable(database, "accounts") ? count(database, "SELECT COUNT(*) AS count FROM accounts") : 0,
    rewrites: hasTable(database, "article_rewrites") ? count(database, "SELECT COUNT(*) AS count FROM article_rewrites") : 0,
    userStateRows: countUserStateRows(database)
  };
}

const INTERNAL_LIBRARY_TABLES = new Set(["schema_migrations", "library_state", "data_location_migrations"]);

/**
 * A usable library may contain user-owned state without any feed cards: for
 * example followed Zhihu authors, dismissed items, facets or rewrite settings.
 * Count all durable application tables except the schema/session bookkeeping
 * tables so an old library is never mistaken for disposable boilerplate.
 */
function countUserStateRows(database: Database.Database): number {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables
    .filter(({ name }) => !INTERNAL_LIBRARY_TABLES.has(name))
    .reduce((total, { name }) => total + count(database, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`), 0);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * A local digest lets us recognize an untouched historical copy without
 * recording any of its rows in the migration manifest. It is never logged or
 * transmitted. Rows are streamed so a historical directory with many cards or
 * rewrites does not materialise its full private library in memory; normal
 * startup without a legacy candidate does not call it.
 */
function fingerprintLibrary(filePath: string): string {
  let database: Database.Database | undefined;
  try {
    database = new Database(filePath, { readonly: true, fileMustExist: true });
    const hash = createHash("sha256");
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    for (const { name, sql } of tables) {
      hash.update(name);
      hash.update("\u0000");
      hash.update(sql ?? "");
      hash.update("\u0000");
      for (const row of orderedTableRows(database, name)) {
        hash.update(JSON.stringify(row));
        hash.update("\u0000");
      }
    }
    return hash.digest("hex");
  } finally {
    database?.close();
  }
}

function* orderedTableRows(database: Database.Database, table: string): IterableIterator<unknown> {
  const primaryKey = (database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => quoteIdentifier(column.name));
  const orderBy = primaryKey.length ? primaryKey.join(", ") : "rowid";
  yield* database.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`).iterate() as IterableIterator<unknown>;
}

function hashSourceLocator(filePath: string): string {
  return createHash("sha256").update(resolve(filePath)).digest("hex");
}

function isValidLibrary(library: LibraryInspection): library is ValidLibrary {
  return library.state === "valid" && typeof library.schemaVersion === "number" && library.counts !== undefined;
}

function isNonEmpty(counts: LibraryCounts): boolean {
  return counts.userStateRows > 0;
}

function blocked(databasePath: string, canonicalDirectory: string, libraries: readonly LibraryInspection[], message: string): DataLocationResolution {
  return { kind: "blocked", databasePath, canonicalDirectory, libraries, message };
}

async function backupBeforeSchemaUpgrade(library: ValidLibrary, canonicalDirectory: string, now: () => number): Promise<string | undefined> {
  if (library.schemaVersion >= CURRENT_SCHEMA_VERSION) return undefined;
  const backupsDirectory = await ensureBackupsDirectory(canonicalDirectory);
  const backupPath = join(backupsDirectory, `pre-schema-v${library.schemaVersion}-${stamp(now())}-${randomUUID()}.sqlite`);
  await sqliteBackup(library.path, backupPath);
  return backupPath;
}

async function migrateLegacyLibrary(
  source: ValidLibrary,
  canonical: LibraryInspection,
  canonicalDirectory: string,
  canonicalPath: string,
  libraryFileName: string,
  now: () => number
): Promise<DataLocationResolution> {
  const backupsDirectory = await ensureBackupsDirectory(canonicalDirectory);
  const migrationId = `${stamp(now())}-${randomUUID()}`;
  const backupPath = join(backupsDirectory, `legacy-${migrationId}.sqlite`);
  const metadataPath = join(backupsDirectory, `data-migration-${migrationId}.json`);
  const stagingDirectory = await createStagingDirectory(canonicalDirectory, migrationId);
  const stagingPath = join(stagingDirectory, libraryFileName);
  const record: MigrationRecord = {
    version: DATA_LOCATION_MIGRATION_VERSION,
    migrationId,
    status: "prepared",
    createdAt: now(),
    sourcePath: source.path,
    canonicalPath,
    backupPath,
    sourceSchemaVersion: source.schemaVersion,
    targetSchemaVersion: CURRENT_SCHEMA_VERSION,
    sourceCounts: source.counts,
    sourceFingerprint: "",
    sourceLocatorHash: hashSourceLocator(source.path),
    sessionStorage: "not-migrated"
  };

  try {
    // The immutable pre-upgrade backup comes first. `backup()` includes
    // committed WAL state, unlike copying the main .sqlite file directly.
    await sqliteBackup(source.path, backupPath);
    const sourceSnapshot = inspectLibrarySync(backupPath);
    if (!isValidLibrary(sourceSnapshot)) throw new Error("历史资料库的升级前备份无法验证。");
    record.sourceSchemaVersion = sourceSnapshot.schemaVersion;
    record.sourceCounts = sourceSnapshot.counts;
    record.sourceFingerprint = fingerprintLibrary(backupPath);
    assertSourceSnapshotUnchanged(source.path, record.sourceFingerprint);
    await writeMigrationRecord(metadataPath, record);
    await copyFile(backupPath, stagingPath);
    await chmod(stagingPath, 0o600);
    const target = migrateAndInspectStaging(stagingPath, {
      migrationId,
      sourceFingerprint: record.sourceFingerprint,
      sourceLocatorHash: record.sourceLocatorHash,
      sourceSchemaVersion: sourceSnapshot.schemaVersion,
      migratedAt: now()
    });
    if (target.state !== "valid" || target.schemaVersion !== CURRENT_SCHEMA_VERSION || !target.counts || !countsPreserved(sourceSnapshot.counts, target.counts)) {
      throw new Error("历史资料库迁移后的数据校验未通过。");
    }
    // A legacy build does not know about the new application's startup guard.
    // Do not install a snapshot if that older process changed the preserved
    // source while staging was being migrated. The source remains untouched
    // and the user gets a recoverable, explicit conflict instead of a stale
    // import that looks successful.
    assertSourceSnapshotUnchanged(source.path, record.sourceFingerprint);
    record.targetCounts = target.counts;
    await writeMigrationRecord(metadataPath, record);
    const currentCanonical = await backupCanonicalBeforeReplacement(canonicalPath, backupsDirectory, migrationId);
    if (isValidLibrary(currentCanonical.inspection) && isNonEmpty(currentCanonical.inspection.counts)) {
      throw new CompetingCanonicalLibraryError(currentCanonical.inspection);
    }
    record.canonicalBackupPath = currentCanonical.backupPath;
    await writeMigrationRecord(metadataPath, record);
    await replaceCanonicalDatabase(stagingPath, canonicalPath, backupsDirectory, migrationId, currentCanonical.fingerprint);
    record.status = "completed";
    record.completedAt = now();
    await writeMigrationRecord(metadataPath, record);
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    return { kind: "migrated", databasePath: canonicalPath, canonicalDirectory, backupPath, metadataPath, source };
  } catch (error) {
    // Only the generated staging directory is removed. Both the historical
    // source and any pre-upgrade backup deliberately survive a failed update.
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof CompetingCanonicalLibraryError) {
      return {
        kind: "ambiguous",
        databasePath: canonicalPath,
        canonicalDirectory,
        canonical: error.canonical,
        legacyLibraries: [source],
        message: "历史资料库接管前检测到当前资料库已有用户数据。为避免覆盖或自动合并，应用没有选择其中任一份。"
      };
    }
    return blocked(canonicalPath, canonicalDirectory, [canonical, source], migrationFailureMessage(error));
  }
}

function migrateAndInspectStaging(stagingPath: string, marker: DataLocationMarker & { sourceSchemaVersion: number; migratedAt: number }): LibraryInspection {
  let database: Database.Database | undefined;
  try {
    database = new Database(stagingPath, { fileMustExist: true });
    database.pragma("foreign_keys = ON");
    migrateDatabaseSchema(database);
    database.prepare(`INSERT INTO data_location_migrations
      (migration_id, source_fingerprint, source_locator_hash, source_schema_version, migrated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(migration_id) DO UPDATE SET
        source_fingerprint = excluded.source_fingerprint,
        source_locator_hash = excluded.source_locator_hash,
        source_schema_version = excluded.source_schema_version,
        migrated_at = excluded.migrated_at`)
      .run(marker.migrationId, marker.sourceFingerprint, marker.sourceLocatorHash, marker.sourceSchemaVersion, marker.migratedAt);
    const foreignKeyIssues = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeyIssues.length) throw new Error("迁移后的资料库存在外键错误。");
  } finally {
    database?.close();
  }
  return inspectLibrarySync(stagingPath);
}

function inspectLibrarySync(filePath: string): LibraryInspection {
  let database: Database.Database | undefined;
  try {
    database = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check?: string }>;
    if (!integrity.every((row) => row.integrity_check === "ok")
      || (database.pragma("foreign_key_check") as unknown[]).length
      || !hasTable(database, "sources")
      || !hasTable(database, "entries")) {
      return { path: filePath, state: "invalid", issue: "迁移后的资料库无法通过完整性检查。" };
    }
    const schema = readSchemaVersion(database);
    if (!schema.valid) return { path: filePath, state: "invalid", issue: "迁移后的资料库迁移记录不连续。" };
    const schemaVersion = schema.version;
    if (schemaVersion >= 17 && !hasTable(database, "data_location_migrations")) {
      return { path: filePath, state: "invalid", issue: "迁移后的资料库缺少来源标记表。" };
    }
    if (schemaVersion > CURRENT_SCHEMA_VERSION) return { path: filePath, state: "future", schemaVersion, counts: readCounts(database) };
    return { path: filePath, state: "valid", schemaVersion, counts: readCounts(database) };
  } catch {
    return { path: filePath, state: "invalid", issue: "迁移后的资料库无法安全打开。" };
  } finally {
    database?.close();
  }
}

function countsPreserved(before: LibraryCounts, after: LibraryCounts): boolean {
  return after.sources >= before.sources
    && after.entries >= before.entries
    && after.unread >= before.unread
    && after.favorites >= before.favorites
    && after.accounts >= before.accounts
    && after.rewrites >= before.rewrites
    && after.userStateRows >= before.userStateRows;
}

function assertSourceSnapshotUnchanged(sourcePath: string, expectedFingerprint: string): void {
  if (fingerprintLibrary(sourcePath) !== expectedFingerprint) {
    throw new Error("历史资料库在接管期间发生变化；没有覆盖当前资料库。");
  }
}

async function backupCanonicalBeforeReplacement(canonicalPath: string, backupsDirectory: string, migrationId: string): Promise<CanonicalReplacementBackup> {
  const canonical = await inspectLibrary(canonicalPath);
  if (canonical.state === "missing") return { inspection: canonical };
  if (!isValidLibrary(canonical)) throw new Error("当前资料库在接管前已变为无法安全验证的状态。");
  const backupPath = join(backupsDirectory, `canonical-before-import-${migrationId}.sqlite`);
  await sqliteBackup(canonical.path, backupPath);
  const snapshot = inspectLibrarySync(backupPath);
  if (!isValidLibrary(snapshot)) throw new Error("当前资料库的接管前备份无法验证。");
  return { backupPath, inspection: { ...snapshot, path: canonicalPath }, fingerprint: fingerprintLibrary(backupPath) };
}

async function replaceCanonicalDatabase(
  stagingPath: string,
  canonicalPath: string,
  backupsDirectory: string,
  migrationId: string,
  expectedCanonicalFingerprint?: string
): Promise<void> {
  const displaced: Array<{ original: string; backup: string }> = [];
  try {
    const currentExists = await exists(canonicalPath);
    if (expectedCanonicalFingerprint) {
      if (!currentExists || fingerprintLibrary(canonicalPath) !== expectedCanonicalFingerprint) {
        throw new Error("当前资料库在接管期间发生变化；没有覆盖它。");
      }
    } else if (currentExists) {
      throw new Error("当前资料库在接管期间出现；没有覆盖它。");
    }
    for (const suffix of ["-wal", "-shm"] as const) {
      const original = `${canonicalPath}${suffix}`;
      if (!await exists(original)) continue;
      const backup = join(backupsDirectory, `${basename(canonicalPath)}-before-import-${migrationId}${suffix}`);
      await rename(original, backup);
      displaced.push({ original, backup });
    }
    await rename(stagingPath, canonicalPath);
  } catch (error) {
    await Promise.all(displaced.reverse().map(async ({ original, backup }) => {
      if (!await exists(original) && await exists(backup)) await rename(backup, original);
    }));
    throw error;
  }
}

async function ensureBackupsDirectory(canonicalDirectory: string): Promise<string> {
  await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
  const backupsDirectory = join(canonicalDirectory, "backups");
  await mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupsDirectory, 0o700);
  return backupsDirectory;
}

async function createStagingDirectory(canonicalDirectory: string, migrationId: string): Promise<string> {
  const stagingDirectory = join(canonicalDirectory, `.data-migration-${migrationId}`);
  await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  return stagingDirectory;
}

async function sqliteBackup(sourcePath: string, destinationPath: string): Promise<void> {
  let source: Database.Database | undefined;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    await source.backup(destinationPath);
    await chmod(destinationPath, 0o600);
  } finally {
    source?.close();
  }
}

async function writeMigrationRecord(path: string, record: MigrationRecord): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

function stamp(value: number): string {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function migrationFailureMessage(error: unknown): string {
  const suffix = error instanceof Error && error.message ? `（${error.message}）` : "";
  return `历史资料库未能安全接管${suffix}。原目录和已创建的备份均已保留。`;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
