import type Database from "better-sqlite3";
import type { Source } from "../../shared/types";
import { canonicalizeContentUrl, isScourRssRedirectUrl, isTaxonomyUrl, isZhihuBusinessPromotionUrl } from "../../shared/url";

type SqliteDatabase = Database.Database;

type RepairEntryRow = {
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
  observed_at: number | null;
  provider_id: string | null;
  external_id: string | null;
  canonical_identity: string | null;
  provider_label: string | null;
};

type SourceEntryRow = Pick<RepairEntryRow, "id" | "source_id">;

/**
 * Removes content belonging to one source while preserving a shared content
 * row whenever another source still owns an origin.  All legacy repair tasks
 * use the same ownership-preserving primitive.
 */
export function removeEntriesForSourceOrigins(database: SqliteDatabase, sourceId: string, matches: SourceEntryRow[]): number {
  if (!matches.length) return 0;
  const alternate = database.prepare("SELECT source_id FROM entry_origins WHERE entry_id = ? AND source_id != ? ORDER BY observed_at ASC LIMIT 1");
  const assign = database.prepare("UPDATE entries SET source_id = ? WHERE id = ?");
  const removeOrigin = database.prepare("DELETE FROM entry_origins WHERE entry_id = ? AND source_id = ?");
  const removeContent = database.prepare("DELETE FROM entries WHERE id = ? AND NOT EXISTS (SELECT 1 FROM entry_origins WHERE entry_origins.entry_id = entries.id)");
  database.transaction(() => {
    for (const entry of matches) {
      const fallback = alternate.get(entry.id, sourceId) as { source_id: string } | undefined;
      if (entry.source_id === sourceId && fallback) assign.run(fallback.source_id, entry.id);
      removeOrigin.run(entry.id, sourceId);
      removeContent.run(entry.id);
    }
  })();
  return matches.length;
}

export function deleteTaxonomyEntries(database: SqliteDatabase, sourceId: string): number {
  // Do not encode taxonomy detection as broad SQL `LIKE '%/archives/%'`.
  // Scientific Spaces uses `/archives/<article-id>` for real posts, so that
  // legacy heuristic could erase valid content during a one-time cleanup.
  // This scan is deliberately source-scoped and runs only during migration;
  // use the same URL classifier as live generic extraction.
  const matches = (database
    .prepare("SELECT id, source_id, original_url FROM entries WHERE source_id = ?")
    .all(sourceId) as Array<SourceEntryRow & { original_url: string }>)
    .filter((entry) => isTaxonomyUrl(entry.original_url));
  return removeEntriesForSourceOrigins(database, sourceId, matches);
}

/** Removes legacy Zhihu ideas and bare question activity kept by older builds. */
export function deleteUnsupportedZhihuFollowEntries(database: SqliteDatabase, sourceId: string): number {
  const matches = database.prepare(`SELECT id, source_id FROM entries WHERE source_id = ? AND (
    original_url LIKE 'https://www.zhihu.com/pin/%' OR
    (original_url LIKE 'https://www.zhihu.com/question/%' AND original_url NOT LIKE '%/answer/%')
  )`).all(sourceId) as SourceEntryRow[];
  return removeEntriesForSourceOrigins(database, sourceId, matches);
}

/** Removes legacy sponsored Follow cards while retaining authored posts. */
export function deletePromotedZhihuFollowEntries(database: SqliteDatabase, sourceId: string): number {
  const candidates = database.prepare("SELECT id, source_id, original_url FROM entries WHERE source_id = ?")
    .all(sourceId) as Array<SourceEntryRow & { original_url: string }>;
  const matches = candidates.filter((entry) => isZhihuBusinessPromotionUrl(entry.original_url));
  return removeEntriesForSourceOrigins(database, sourceId, matches);
}

/**
 * Older builds treated per-delivery Scour redirect parameters as part of a
 * card URL. Merge only rows that resolve to the same RSS redirect wrapper;
 * read/favorite state and every source origin survive the consolidation.
 */
export function repairScourRedirectEntries(database: SqliteDatabase, sourceId: string): number {
  const sourceRows = database.prepare(`SELECT id, source_id, canonical_url, original_url, title, author, published_at, summary, image_url,
    content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity
    FROM entries WHERE source_id = ?`).all(sourceId) as RepairEntryRow[];
  const repairs = sourceRows.flatMap((row) => {
    try {
      if (!isScourRssRedirectUrl(row.canonical_url)) return [];
      const canonicalUrl = canonicalizeContentUrl(row.canonical_url);
      return canonicalUrl === row.canonical_url ? [] : [{ row, canonicalUrl }];
    } catch {
      return [];
    }
  });
  if (!repairs.length) return 0;

  const groups = new Map<string, RepairEntryRow[]>();
  for (const repair of repairs) {
    const group = groups.get(repair.canonicalUrl) ?? [];
    group.push(repair.row);
    groups.set(repair.canonicalUrl, group);
  }
  const findByCanonicalUrl = database.prepare(`SELECT id, source_id, canonical_url, original_url, title, author, published_at, summary, image_url,
    content_hash, is_read, is_favorite, created_at, observed_at, provider_id, provider_label, external_id, canonical_identity
    FROM entries WHERE canonical_url = ?`);
  const originsForEntry = database.prepare(`SELECT source_id, provider_id, provider_label, external_id, original_url, observed_at
    FROM entry_origins WHERE entry_id = ?`);
  const insertOrigin = database.prepare(`INSERT OR IGNORE INTO entry_origins
    (entry_id, source_id, provider_id, provider_label, external_id, original_url, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const facetsForOrigin = database.prepare(`SELECT facet_id FROM entry_origin_facets
    WHERE entry_id = ? AND source_id = ? AND provider_id = ? AND external_id = ?`);
  const insertOriginFacet = database.prepare(`INSERT OR IGNORE INTO entry_origin_facets
    (entry_id, source_id, provider_id, external_id, facet_id) VALUES (?, ?, ?, ?, ?)`);
  const deleteOrigins = database.prepare("DELETE FROM entry_origins WHERE entry_id = ?");
  const deleteEntry = database.prepare("DELETE FROM entries WHERE id = ?");
  const updateWinner = database.prepare(`UPDATE entries SET canonical_url = ?, canonical_identity = ?,
    is_read = ?, is_favorite = ?, author = ?, published_at = ?, summary = ?, image_url = ?, created_at = ?, observed_at = ? WHERE id = ?`);
  const originOwner = database.prepare("SELECT source_id FROM entry_origins WHERE entry_id = ? ORDER BY observed_at ASC LIMIT 1");
  const updateOwner = database.prepare("UPDATE entries SET source_id = ? WHERE id = ?");

  database.transaction(() => {
    for (const [canonicalUrl, candidates] of groups) {
      const existing = findByCanonicalUrl.get(canonicalUrl) as RepairEntryRow | undefined;
      const rows = existing && !candidates.some((candidate) => candidate.id === existing.id)
        ? [...candidates, existing]
        : candidates;
      const winner = choosePreferredEntry(rows);
      const losers = rows.filter((row) => row.id !== winner.id);
      for (const loser of losers) {
        for (const origin of originsForEntry.all(loser.id) as Array<{ source_id: string; provider_id: string; provider_label: string | null; external_id: string; original_url: string; observed_at: number }>) {
          insertOrigin.run(winner.id, origin.source_id, origin.provider_id, origin.provider_label, origin.external_id, origin.original_url, origin.observed_at);
          for (const facet of facetsForOrigin.all(loser.id, origin.source_id, origin.provider_id, origin.external_id) as Array<{ facet_id: string }>) {
            insertOriginFacet.run(winner.id, origin.source_id, origin.provider_id, origin.external_id, facet.facet_id);
          }
        }
        deleteOrigins.run(loser.id);
        deleteEntry.run(loser.id);
      }
      const state = mergeEntryState(rows, winner);
      updateWinner.run(canonicalUrl, canonicalUrl, state.read, state.favorite, state.author, state.publishedAt, state.summary, state.imageUrl, state.createdAt, state.observedAt, winner.id);
      const owner = originOwner.get(winner.id) as { source_id: string } | undefined;
      if (owner) updateOwner.run(owner.source_id, winner.id);
    }
  })();
  return repairs.length;
}

/** Repairs legacy generic cards whose article link was saved as the source homepage. */
export function repairGenericHomepageEntryUrls(database: SqliteDatabase, source: Source): number {
  if (source.kind !== "generic") return 0;
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(canonicalizeContentUrl(source.url));
  } catch {
    return 0;
  }
  const candidates = database.prepare(`SELECT id, canonical_url, canonical_identity FROM entries WHERE source_id = ?`)
    .all(source.id) as Array<{ id: string; canonical_url: string; canonical_identity: string | null }>;
  const updateEntry = database.prepare("UPDATE entries SET canonical_url = ?, original_url = ?, canonical_identity = ? WHERE id = ?");
  const updateOrigin = database.prepare("UPDATE entry_origins SET original_url = ? WHERE entry_id = ? AND source_id = ?");
  const exists = database.prepare("SELECT 1 FROM entries WHERE canonical_url = ? AND id != ?");
  const usedCanonicalUrls = new Set<string>();
  const repairs = candidates.flatMap((entry) => {
    if (!entry.canonical_identity) return [];
    try {
      const cardUrl = new URL(entry.canonical_url);
      const target = canonicalizeContentUrl(entry.canonical_identity);
      const targetUrl = new URL(target);
      const isSourceHomepage = cardUrl.origin === sourceUrl.origin && cardUrl.pathname === sourceUrl.pathname;
      if (!isSourceHomepage || targetUrl.origin !== sourceUrl.origin || target === sourceUrl.toString() || usedCanonicalUrls.has(target)) return [];
      if (exists.get(target, entry.id)) return [];
      usedCanonicalUrls.add(target);
      return [{ id: entry.id, target }];
    } catch {
      return [];
    }
  });
  if (!repairs.length) return 0;
  database.transaction(() => {
    for (const repair of repairs) {
      updateEntry.run(repair.target, repair.target, repair.target, repair.id);
      updateOrigin.run(repair.target, repair.id, source.id);
    }
  })();
  return repairs.length;
}

function choosePreferredEntry(entries: RepairEntryRow[]): RepairEntryRow {
  return [...entries].sort((left, right) => entryQuality(right) - entryQuality(left))[0]!;
}

function entryQuality(entry: RepairEntryRow): number {
  return Number(Boolean(entry.is_favorite)) * 1_000_000
    + Number(Boolean(entry.is_read)) * 100_000
    + Number(Boolean(entry.published_at)) * 10_000
    + (entry.summary?.length ?? 0) * 10
    + Number(Boolean(entry.image_url)) * 100
    + (entry.observed_at ?? entry.created_at);
}

function mergeEntryState(entries: RepairEntryRow[], preferred: RepairEntryRow): {
  read: number;
  favorite: number;
  author: string | null;
  publishedAt: number | null;
  summary: string | null;
  imageUrl: string | null;
  createdAt: number;
  observedAt: number;
} {
  const first = <T>(value: (entry: RepairEntryRow) => T | null | undefined): T | null => entries.map(value).find((item): item is T => item !== null && item !== undefined) ?? null;
  const longest = (value: (entry: RepairEntryRow) => string | null): string | null => entries
    .map(value)
    .filter((item): item is string => Boolean(item))
    .sort((left, right) => right.length - left.length)[0] ?? null;
  return {
    read: Number(entries.some((entry) => Boolean(entry.is_read))),
    favorite: Number(entries.some((entry) => Boolean(entry.is_favorite))),
    author: preferred.author ?? first((entry) => entry.author),
    publishedAt: preferred.published_at ?? first((entry) => entry.published_at),
    summary: longest((entry) => entry.summary),
    imageUrl: preferred.image_url ?? first((entry) => entry.image_url),
    createdAt: Math.min(...entries.map((entry) => entry.created_at)),
    observedAt: Math.max(...entries.map((entry) => entry.observed_at ?? entry.created_at))
  };
}
