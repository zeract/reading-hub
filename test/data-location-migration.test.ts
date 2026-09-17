import Sqlite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadingDatabase } from "../src/main/database";
import { resolveDataLocation } from "../src/main/data-location-migration";
import { CURRENT_SCHEMA_VERSION } from "../src/main/persistence/schema";

const NOW = 1_735_000_000_000;
const DATABASE_FILENAME = "reading-hub.sqlite";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "reading-hub-data-location-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("startup data-location migration", () => {
  it("imports a single valid legacy library into the canonical location without deleting its source", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Electron");
    const legacy = createLibrary(legacyDirectory, "legacy-only");
    const legacyPath = databasePath(legacyDirectory);

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") throw new Error("expected migrated data location");
    expect(result.databasePath).toBe(databasePath(canonicalDirectory));
    expect(existsSync(legacyPath)).toBe(true);
    expect(readLibrary(result.databasePath)).toMatchObject({
      sources: [expect.objectContaining({ id: legacy.sourceId, title: "legacy-only source" })],
      entries: [expect.objectContaining({ id: legacy.entryId, title: "legacy-only article" })]
    });
    // The backup is intentionally a coherent SQLite database, not a raw copy
    // of the source's main file. It remains available for a user-led recovery.
    expect(existsSync(result.backupPath)).toBe(true);
    expect(readLibrary(result.backupPath)).toMatchObject({
      sources: [expect.objectContaining({ id: legacy.sourceId })],
      entries: [expect.objectContaining({ id: legacy.entryId })]
    });

    // The historical source intentionally remains in place. Its immutable
    // snapshot record must prevent a later launch from mistaking it for a
    // competing library and blocking the upgraded application.
    const restarted = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW + 1
    });
    expect(restarted.kind).toBe("canonical");
  });

  it("imports a historical library that only contains followed-author state", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    createFolloweeOnlyLibrary(legacyDirectory, "followee-only");

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") throw new Error("expected migrated data location");
    expect(rows(result.databasePath, "SELECT url_token, fullname FROM followees")).toEqual([
      { url_token: "followee-only", fullname: "followee-only author" }
    ]);
  });

  it("upgrades a pre-v17 historical library without losing checkpoints, facets, dismissed content, or rewrite settings", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    const legacy = createLibrary(legacyDirectory, "pre-v17");
    const legacyPath = databasePath(legacyDirectory);
    const raw = new Sqlite(legacyPath);
    try {
      raw.prepare(`INSERT INTO sync_checkpoints (subscription_id, cursor, since_id, data_json, updated_at)
        VALUES (?, ?, ?, ?, ?)`).run(legacy.sourceId, "checkpoint-cursor", "checkpoint-since", '{"page":2}', NOW);
      raw.prepare("INSERT INTO dismissed_contents (canonical_identity, dismissed_at) VALUES (?, ?)")
        .run("https://pre-v17.example.test/dismissed", NOW);
      raw.prepare(`INSERT INTO facets (id, scheme, facet_key, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run("facet-pre-v17", "category", "systems", "Systems", NOW, NOW);
      raw.prepare("INSERT INTO subscription_scope_facets (subscription_id, facet_id) VALUES (?, ?)")
        .run(legacy.sourceId, "facet-pre-v17");
      raw.prepare("INSERT INTO rewrite_settings (id, settings_json) VALUES (1, ?)")
        .run('{"provider":"codex"}');
      raw.exec("DROP TABLE data_location_migrations");
      raw.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CURRENT_SCHEMA_VERSION);
    } finally {
      raw.close();
    }

    const result = await resolveDataLocation({ canonicalDirectory, legacyDirectories: [legacyDirectory], now: () => NOW });

    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") throw new Error("expected migrated data location");
    expect(rows(result.databasePath, "SELECT cursor, since_id, data_json FROM sync_checkpoints")).toEqual([
      { cursor: "checkpoint-cursor", since_id: "checkpoint-since", data_json: '{"page":2}' }
    ]);
    expect(rows(result.databasePath, "SELECT canonical_identity FROM dismissed_contents")).toEqual([
      { canonical_identity: "https://pre-v17.example.test/dismissed" }
    ]);
    expect(rows(result.databasePath, `SELECT facets.label FROM subscription_scope_facets
      INNER JOIN facets ON facets.id = subscription_scope_facets.facet_id`)).toEqual([{ label: "Systems" }]);
    expect(rows(result.databasePath, "SELECT settings_json FROM rewrite_settings")).toEqual([{ settings_json: '{"provider":"codex"}' }]);
    const metadata = JSON.parse(readFileSync(result.metadataPath, "utf8")) as {
      sourceCounts: { userStateRows: number };
      targetCounts: { userStateRows: number };
    };
    expect(metadata.targetCounts.userStateRows).toBeGreaterThanOrEqual(metadata.sourceCounts.userStateRows);
    expect(rows(result.databasePath, "SELECT migration_id FROM data_location_migrations")).toHaveLength(1);
  });

  it("does not replace a current library that only contains durable user state", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    createDismissedOnlyLibrary(canonicalDirectory, "current-dismissed");
    createLibrary(legacyDirectory, "legacy-card");

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("ambiguous");
    expect(rows(databasePath(canonicalDirectory), "SELECT canonical_identity FROM dismissed_contents")).toEqual([
      { canonical_identity: "https://current-dismissed.example.test/dismissed" }
    ]);
    expect(readLibrary(databasePath(legacyDirectory)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "legacy-card article" })
    ]));
  });

  it("blocks competing nonempty canonical and legacy libraries instead of silently choosing one", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    const canonical = createLibrary(canonicalDirectory, "canonical");
    const legacy = createLibrary(legacyDirectory, "legacy-competing");
    const canonicalPath = databasePath(canonicalDirectory);
    const legacyPath = databasePath(legacyDirectory);

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("ambiguous");
    expect(readLibrary(canonicalPath)).toMatchObject({
      entries: [expect.objectContaining({ id: canonical.entryId })]
    });
    expect(readLibrary(legacyPath)).toMatchObject({
      entries: [expect.objectContaining({ id: legacy.entryId })]
    });
    // Competing databases are never merged, replaced, or silently discarded.
  });

  it("blocks an empty canonical location with competing legacy libraries instead of guessing which one to import", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const firstLegacyDirectory = join(directory, "Reading Hub");
    const secondLegacyDirectory = join(directory, "readinghub");
    mkdirSync(canonicalDirectory, { recursive: true });
    const first = createLibrary(firstLegacyDirectory, "legacy-first");
    const second = createLibrary(secondLegacyDirectory, "legacy-second");
    const firstPath = databasePath(firstLegacyDirectory);
    const secondPath = databasePath(secondLegacyDirectory);
    const firstBefore = readFileSync(firstPath);
    const secondBefore = readFileSync(secondPath);

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [firstLegacyDirectory, secondLegacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("ambiguous");
    expect(existsSync(databasePath(canonicalDirectory))).toBe(false);
    expect(readFileSync(firstPath)).toEqual(firstBefore);
    expect(readFileSync(secondPath)).toEqual(secondBefore);
    expect(readLibrary(firstPath).entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.entryId })]));
    expect(readLibrary(secondPath).entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.entryId })]));
  });

  it("uses a SQLite backup that includes committed WAL data and writes metadata without library content or Keychain references", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    const legacyPath = databasePath(legacyDirectory);
    mkdirSync(legacyDirectory, { recursive: true });
    const writer = new ReadingDatabase(legacyPath);
    let sourceId: string | undefined;
    try {
      const source = writer.createSource({
        url: "https://wal.example.test/feed.xml",
        title: "wal source",
        kind: "rss",
        pollingEnabled: true
      });
      sourceId = source.id;
      writer.saveAccount({
        id: "account-with-keychain-reference",
        connectorId: "x",
        displayName: "migration account",
        keychainAccount: "keychain-reference-sentinel",
        scopes: [],
        status: "active"
      });
      writer.saveEntries([entry(source.id, "checkpointed", "checkpointed article")]);
      // Make the next entry reside in the WAL. Keeping this connection open
      // verifies migration uses SQLite's backup API rather than copying only
      // the main `*.sqlite` file and silently losing recent cards.
      const raw = writer as unknown as { db: Sqlite.Database };
      raw.db.pragma("wal_checkpoint(TRUNCATE)");
      writer.saveEntries([entry(source.id, "wal-only", "wal-only article", "article-body-sentinel")]);
      expect(existsSync(`${legacyPath}-wal`)).toBe(true);

      const result = await resolveDataLocation({
        canonicalDirectory,
        legacyDirectories: [legacyDirectory],
        now: () => NOW
      });

      expect(result.kind).toBe("migrated");
      if (result.kind !== "migrated") throw new Error("expected migrated data location");
      expect(existsSync(result.backupPath)).toBe(true);
      expect(existsSync(result.metadataPath)).toBe(true);
      expect(readLibrary(result.databasePath).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "checkpointed article" }),
        expect.objectContaining({ title: "wal-only article", summary: "article-body-sentinel" })
      ]));
      expect(readLibrary(result.backupPath).entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "wal-only article" })
      ]));
      const metadata = JSON.parse(readFileSync(result.metadataPath, "utf8")) as Record<string, unknown>;
      expect(metadata).toEqual(expect.any(Object));
      const metadataText = JSON.stringify(metadata);
      expect(metadataText).not.toContain("article-body-sentinel");
      expect(metadataText).not.toContain("keychain-reference-sentinel");
      expect(existsSync(legacyPath)).toBe(true);
    } finally {
      writer.close();
    }
    expect(sourceId).toBeDefined();
  });

  it("recovers a prepared migration record after an interruption following the atomic database replacement", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    createLibrary(legacyDirectory, "interrupted");

    const migrated = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });
    expect(migrated.kind).toBe("migrated");
    if (migrated.kind !== "migrated") throw new Error("expected migrated data location");
    const record = JSON.parse(readFileSync(migrated.metadataPath, "utf8")) as Record<string, unknown>;
    record.status = "prepared";
    delete record.completedAt;
    writeFileSync(migrated.metadataPath, `${JSON.stringify(record)}\n`);

    const restarted = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW + 1
    });
    expect(restarted.kind).toBe("canonical");
    expect(JSON.parse(readFileSync(migrated.metadataPath, "utf8"))).toMatchObject({ status: "completed", completedAt: NOW + 1 });
  });

  it("does not let a sidecar record hide a historical library after the active database is replaced", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    createLibrary(legacyDirectory, "marker-source");

    const migrated = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });
    expect(migrated.kind).toBe("migrated");
    const canonicalPath = databasePath(canonicalDirectory);
    removeDatabaseFiles(canonicalPath);
    createLibrary(canonicalDirectory, "replacement");

    const restarted = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW + 1
    });
    expect(restarted.kind).toBe("ambiguous");
    expect(readLibrary(canonicalPath).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "replacement article" })
    ]));
    expect(readLibrary(databasePath(legacyDirectory)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "marker-source article" })
    ]));
  });

  it("requires the in-library origin marker before accepting a retained historical source", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    createLibrary(legacyDirectory, "marker-required");

    const migrated = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });
    expect(migrated.kind).toBe("migrated");
    if (migrated.kind !== "migrated") throw new Error("expected migrated data location");
    const raw = new Sqlite(migrated.databasePath);
    try {
      raw.exec("DELETE FROM data_location_migrations");
    } finally {
      raw.close();
    }

    const restarted = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW + 1
    });
    expect(restarted.kind).toBe("ambiguous");
  });

  it("treats a changed retained historical library as a competing library", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    const legacy = createLibrary(legacyDirectory, "marker-changed");

    const migrated = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });
    expect(migrated.kind).toBe("migrated");
    const legacyDatabase = new ReadingDatabase(databasePath(legacyDirectory));
    try {
      legacyDatabase.saveEntries([entry(legacy.sourceId, "marker-changed-later", "later article")]);
    } finally {
      legacyDatabase.close();
    }

    const restarted = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW + 1
    });
    expect(restarted.kind).toBe("ambiguous");
  });

  it("blocks a corrupt legacy candidate without creating a replacement database or deleting the original", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    const legacyPath = databasePath(legacyDirectory);
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(legacyPath, "not a SQLite database");
    const before = readFileSync(legacyPath);

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("blocked");
    expect(existsSync(databasePath(canonicalDirectory))).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(legacyPath)).toEqual(before);
  });

  it("backs up an older current schema before normal startup upgrades it", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const canonical = createLibrary(canonicalDirectory, "older-current");
    const canonicalPath = databasePath(canonicalDirectory);
    const raw = new Sqlite(canonicalPath);
    try {
      raw.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CURRENT_SCHEMA_VERSION);
      // Mirror the pre-v17 schema rather than merely changing the marker:
      // migration 17 creates the durable origin-marker table.
      raw.exec("DROP TABLE data_location_migrations");
    } finally {
      raw.close();
    }

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [],
      now: () => NOW
    });

    expect(result.kind).toBe("canonical");
    if (result.kind !== "canonical") throw new Error("expected canonical data location");
    expect(result.migrationBackupPath).toBeDefined();
    expect(existsSync(result.migrationBackupPath!)).toBe(true);
    expect(readLibrary(result.migrationBackupPath!).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: canonical.entryId, title: "older-current article" })
    ]));
    expect(readLibrary(canonicalPath).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: canonical.entryId })
    ]));
  });

  it("blocks a future-version historical library without creating a canonical database", async () => {
    const canonicalDirectory = join(directory, "reading-hub");
    const legacyDirectory = join(directory, "Reading Hub");
    createLibrary(legacyDirectory, "future-legacy");
    const legacyPath = databasePath(legacyDirectory);
    const raw = new Sqlite(legacyPath);
    try {
      raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(CURRENT_SCHEMA_VERSION + 1, "future-release", NOW);
    } finally {
      raw.close();
    }
    const before = readFileSync(legacyPath);

    const result = await resolveDataLocation({
      canonicalDirectory,
      legacyDirectories: [legacyDirectory],
      now: () => NOW
    });

    expect(result.kind).toBe("blocked");
    expect(existsSync(databasePath(canonicalDirectory))).toBe(false);
    expect(readFileSync(legacyPath)).toEqual(before);
  });
});

function databasePath(location: string): string {
  return join(location, DATABASE_FILENAME);
}

function createLibrary(location: string, label: string): { sourceId: string; entryId: string } {
  mkdirSync(location, { recursive: true });
  const database = new ReadingDatabase(databasePath(location));
  try {
    const source = database.createSource({
      url: `https://${label}.example.test/feed.xml`,
      title: `${label} source`,
      kind: "rss",
      pollingEnabled: true
    });
    const saved = entry(source.id, label, `${label} article`);
    database.saveEntries([saved]);
    return { sourceId: source.id, entryId: saved.id };
  } finally {
    database.close();
  }
}

function createFolloweeOnlyLibrary(location: string, label: string): void {
  mkdirSync(location, { recursive: true });
  const database = new ReadingDatabase(databasePath(location));
  try {
    const raw = database as unknown as { db: Sqlite.Database };
    raw.db.prepare(`INSERT INTO followees
      (url_token, fullname, url, avatar_url, headline, follower_count, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?)`)
      .run(label, `${label} author`, `https://www.zhihu.com/people/${label}`, NOW);
  } finally {
    database.close();
  }
}

function createDismissedOnlyLibrary(location: string, label: string): void {
  mkdirSync(location, { recursive: true });
  const database = new ReadingDatabase(databasePath(location));
  try {
    const raw = database as unknown as { db: Sqlite.Database };
    raw.db.prepare("INSERT INTO dismissed_contents (canonical_identity, dismissed_at) VALUES (?, ?)")
      .run(`https://${label}.example.test/dismissed`, NOW);
  } finally {
    database.close();
  }
}

function entry(sourceId: string, label: string, title: string, summary = `${label} summary`) {
  return {
    id: `entry-${label}`,
    sourceId,
    canonicalUrl: `https://${label}.example.test/posts/${label}`,
    url: `https://${label}.example.test/posts/${label}`,
    title,
    summary,
    contentHash: `${label}-hash`,
    read: false,
    favorite: false,
    createdAt: NOW,
    observedAt: NOW,
    providerId: "rss" as const
  };
}

function readLibrary(path: string): { sources: Array<{ id: string; title: string }>; entries: Array<{ id: string; title: string; summary?: string }> } {
  const database = new ReadingDatabase(path);
  try {
    return {
      sources: database.listSources().map((source) => ({ id: source.id, title: source.title })),
      entries: database.listEntries({ limit: 100 }).map((item) => ({ id: item.id, title: item.title, summary: item.summary }))
    };
  } finally {
    database.close();
  }
}

function rows(path: string, query: string): Array<Record<string, unknown>> {
  const database = new Sqlite(path, { readonly: true });
  try {
    return database.prepare(query).all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

function removeDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) rmSync(candidate, { force: true });
}
