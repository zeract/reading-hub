import { load } from "cheerio";
import type { ConnectorAdapter, Entry, ExtractionRule, Facet, RawEntry, Source, Subscription, SyncCheckpoint, SyncContext, SyncResult } from "../shared/types";
import { normaliseFacets } from "../shared/subscription-scope";
import { assertPublicUrl, canonicalizeContentUrl, isTrustedLoopbackFeedUrl } from "../shared/url";
import { inspectPublicArchiveFacets, MAX_ARCHIVE_DOCUMENT_BYTES, parsePublishedArchive, type ArchiveFacetCatalog } from "./archive-backfill";
import { contentNormalizer } from "./content-normalizer";
import { AUTOMATIC_RULE_REVISION, PUBLICATION_DATE_REVISION, extractGenericPage, extractPagePublishedAt, extractPublicationDateFromUrl, withPublicationDateRevision } from "./extractor";
import { discoverFeedUrls, FEED_DISCOVERY_REVISION, looksLikeFeed, parseFeed, RSS_METADATA_REVISION } from "./feed";
import { loadGenericPage } from "./generic-page-loader";
import { PublicHttpClient } from "./http";
import type { PageRenderer } from "./page-renderer";
import { builtInManifest } from "./connector-registry";

/** RSS and public-web fetchers return the same host-owned sync contract. */
export type FetchOutcome = Pick<
  SyncResult,
  "entries" | "notModified" | "emptyIsHealthy" | "etag" | "lastModified" | "extractionRule" | "metadataRevision" | "iconUrl" | "checkpoint"
>;

abstract class BaseConnector {
  constructor(protected readonly http: PublicHttpClient) {}

  normalize(item: RawEntry, source: Source): Entry {
    return contentNormalizer.normalize(item, source);
  }
}

export class RssConnector extends BaseConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("rss", "RSS / Atom / JSON Feed", ["public-http"], []);

  sync(context: SyncContext): Promise<SyncResult> {
    return this.fetchWithMetadata(context.source, context.checkpoint, context.subscription);
  }

  /**
   * Explicit user-action helper for a source settings view. It only reads the
   * configured public archive's metadata through PublicHttpClient; it does
   * not create entries or start a history import.
   */
  async inspectFacets(source: Source): Promise<ArchiveFacetCatalog | undefined> {
    const catalog = archiveCatalogConfig(source);
    return catalog ? inspectPublicArchiveFacets(this.http, catalog.url) : undefined;
  }

  supportsHistoricalCollection(source: Source): boolean {
    return archiveCatalogConfig(source) !== undefined;
  }

  async fetchWithMetadata(source: Source, checkpoint?: SyncCheckpoint, subscription?: Subscription): Promise<FetchOutcome> {
    // A 304 response contains no feed body to replay. After a metadata-parser
    // upgrade, deliberately make one normal public request so existing cards
    // can be enriched; the revision prevents this from recurring on refresh.
    const needsMetadataReplay = source.metadataRevision !== RSS_METADATA_REVISION;
    const allowTrustedLoopbackFeed = source.config?.allowTrustedLoopbackFeed === true && isTrustedLoopbackFeedUrl(source.url);
    const response = await this.http.getText(
      source.url,
      needsMetadataReplay ? undefined : { etag: source.etag, lastModified: source.lastModified },
      allowTrustedLoopbackFeed ? { allowTrustedLoopbackFeed: true } : undefined
    );
    const feed = response.status === 304 ? undefined : await parseFeed(response.text, response.url);
    const archive = await this.fetchSelectedArchiveHistory(source, subscription, checkpoint);
    return {
      // The current Feed is authoritative for its overlapping entries. A
      // one-time archive can supply older records and publication dates, but
      // must never overwrite richer Feed titles/summaries in the same save.
      entries: mergeFeedFirst(feed?.entries ?? [], archive.entries),
      notModified: response.status === 304 && archive.entries.length === 0,
      emptyIsHealthy: true,
      etag: response.etag,
      lastModified: response.lastModified,
      metadataRevision: RSS_METADATA_REVISION,
      iconUrl: feed?.iconUrl,
      checkpoint: archive.checkpoint
    };
  }

  /**
   * Current Feed entries remain the recurring source of truth. A publisher
   * archive is intentionally opt-in: it is read only after the subscription
   * explicitly requests selected/all history, then a scope-aware checkpoint
   * prevents repeat downloads until that scope changes.
   */
  private async fetchSelectedArchiveHistory(
    source: Source,
    subscription: Subscription | undefined,
    checkpoint: SyncCheckpoint | undefined
  ): Promise<{ entries: RawEntry[]; checkpoint?: FetchOutcome["checkpoint"] }> {
    const catalog = archiveCatalogConfig(source);
    const selection = archiveHistorySelection(subscription);
    if (!catalog || !selection) return { entries: [] };
    const fingerprint = archiveHistoryFingerprint(catalog.url, selection);
    const previous = archiveHistoryCheckpoint(checkpoint?.data, fingerprint);
    const now = Date.now();
    if (previous?.completedAt || (previous?.nextAttemptAt !== undefined && previous.nextAttemptAt > now)) return { entries: [] };
    try {
      const response = await this.http.getText(catalog.url, undefined, { maxBytes: MAX_ARCHIVE_DOCUMENT_BYTES });
      const archiveEntries = parsePublishedArchive(response.text, response.url);
      if (!archiveEntries.length) throw new Error("作者公开归档未包含可验证的日期条目。");
      const entries = selectArchiveEntries(archiveEntries, selection);
      return {
        entries,
        checkpoint: {
          data: {
            ...(checkpoint?.data ?? {}),
            archiveHistory: { fingerprint, completedAt: now, importedEntries: entries.length }
          }
        }
      };
    } catch {
      // Do not turn a healthy Feed into a failed source merely because its
      // optional archive is temporarily unavailable. Persist a conservative
      // retry checkpoint so future Feed polls can resume it without a burst.
      const attempts = (previous?.attempts ?? 0) + 1;
      return {
        entries: [],
        checkpoint: {
          data: {
            ...(checkpoint?.data ?? {}),
            archiveHistory: {
              fingerprint,
              attempts,
              nextAttemptAt: now + archiveRetryDelay(attempts)
            }
          }
        }
      };
    }
  }
}

type ArchiveCatalogConfig = { url: string };
type ArchiveHistorySelection = { mode: "selected" | "all"; facets: Facet[]; limit?: number };
type ArchiveHistoryCheckpoint = { fingerprint: string; completedAt?: number; importedEntries?: number; attempts?: number; nextAttemptAt?: number };

/**
 * `archiveCatalog` is discovery metadata only. The legacy `archiveBackfill`
 * descriptor remains readable so existing sources can opt into a deliberate
 * history scope after upgrading, but it can no longer trigger an import by
 * itself.
 */
function archiveCatalogConfig(source: Source): ArchiveCatalogConfig | undefined {
  return archiveUrlFromConfig(source.config?.archiveCatalog) ?? archiveUrlFromConfig(source.config?.archiveBackfill);
}

function archiveUrlFromConfig(value: unknown): ArchiveCatalogConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url.trim()) return undefined;
  try {
    // The descriptor is normally created only by SourceProbe after an
    // explicit same-origin archive link was found. Re-validate here as a
    // defence-in-depth boundary for imported/legacy configuration.
    return { url: assertPublicUrl(record.url).toString() };
  } catch {
    return undefined;
  }
}

function archiveHistorySelection(subscription: Subscription | undefined): ArchiveHistorySelection | undefined {
  const history = subscription?.scope?.history;
  if (!history || (history.mode !== "selected" && history.mode !== "all")) return undefined;
  const facets = Array.isArray(subscription.scope?.facetSelections) ? subscription.scope.facetSelections : [];
  // A selected-history subscription with no selected values is intentionally
  // a no-op rather than an accidental all-history import.
  if (history.mode === "selected" && !facets.length) return undefined;
  return {
    mode: history.mode,
    facets: normaliseFacets(facets),
    limit: archiveHistoryLimit(history.limit)
  };
}

function archiveHistoryLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const limit = Math.floor(value);
  return limit > 0 ? Math.min(limit, MAX_ARCHIVE_HISTORY_LIMIT) : undefined;
}

const MAX_ARCHIVE_HISTORY_LIMIT = 5_000;

function archiveHistoryFingerprint(url: string, selection: ArchiveHistorySelection): string {
  const facets = selection.facets
    .map((facet) => `${facet.scheme}\u0000${facet.key}`)
    .sort()
    .join("\u0001");
  return JSON.stringify({ url, mode: selection.mode, facets, limit: selection.limit ?? null });
}

function archiveHistoryCheckpoint(data: Record<string, unknown> | undefined, fingerprint: string): ArchiveHistoryCheckpoint | undefined {
  const value = data?.archiveHistory;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.fingerprint !== fingerprint) return undefined;
  return {
    fingerprint,
    completedAt: finiteCheckpointNumber(record.completedAt),
    importedEntries: finiteCheckpointNumber(record.importedEntries),
    attempts: finiteCheckpointNumber(record.attempts),
    nextAttemptAt: finiteCheckpointNumber(record.nextAttemptAt)
  };
}

/** Applies an explicit archive policy after parsing its metadata. */
function selectArchiveEntries(entries: RawEntry[], selection: ArchiveHistorySelection): RawEntry[] {
  const selected = selection.mode === "all" ? entries : entries.filter((entry) => {
    const facets = entry.facets ?? [];
    return facets.some((facet) => selection.facets.some((selectedFacet) => (
      selectedFacet.scheme === facet.scheme && selectedFacet.key === facet.key
    )));
  });
  const ordered = [...selected].sort((left, right) => (right.publishedAt ?? 0) - (left.publishedAt ?? 0) || left.url.localeCompare(right.url));
  return selection.limit === undefined ? ordered : ordered.slice(0, selection.limit);
}

function finiteCheckpointNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function archiveRetryDelay(attempts: number): number {
  return Math.min(24 * 60 * 60_000, 30 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

function mergeFeedFirst(feedEntries: RawEntry[], archiveEntries: RawEntry[]): RawEntry[] {
  const archiveByIdentity = new Map<string, RawEntry>();
  for (const archive of archiveEntries) {
    const identity = entryIdentity(archive);
    const existing = archiveByIdentity.get(identity);
    if (!existing || (archive.publishedAt ?? 0) > (existing.publishedAt ?? 0)) archiveByIdentity.set(identity, archive);
  }
  const mergedFeed = feedEntries.map((feed) => {
    const archive = archiveByIdentity.get(entryIdentity(feed));
    return archive ? mergeFeedArchiveMetadata(feed, archive) : feed;
  });
  const known = new Set(mergedFeed.map(entryIdentity));
  const olderOnly = archiveEntries.filter((entry) => {
    const identity = entryIdentity(entry);
    if (known.has(identity)) return false;
    known.add(identity);
    return true;
  });
  return [...mergedFeed, ...olderOnly];
}

/**
 * The Feed owns user-visible current metadata, while its matching archive can
 * fill a missing timestamp and carry the publisher's taxonomy declaration.
 * This is particularly important when a Feed has no `<category>` fields but
 * its explicitly linked archive does.
 */
function mergeFeedArchiveMetadata(feed: RawEntry, archive: RawEntry): RawEntry {
  const facets = normaliseFacets([...(feed.facets ?? []), ...(archive.facets ?? [])]);
  return {
    ...feed,
    ...(feed.publishedAt === undefined && archive.publishedAt !== undefined ? { publishedAt: archive.publishedAt } : {}),
    ...(facets.length ? { facets } : {})
  };
}

function entryIdentity(entry: Pick<RawEntry, "url" | "canonicalIdentity">): string {
  try {
    return canonicalizeContentUrl(entry.canonicalIdentity ?? entry.url);
  } catch {
    return entry.canonicalIdentity ?? entry.url;
  }
}

export class GenericConnector extends BaseConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("generic", "公开网页", ["public-http"], []);

  constructor(http: PublicHttpClient, private readonly renderer?: PageRenderer) {
    super(http);
  }

  /**
   * A legacy structural rule can retain the source-home link as `url` while
   * extraction has already recovered the post permalink as a canonical
   * identity. Prefer that URL only for a generic, same-site homepage mismatch.
   */
  override normalize(item: RawEntry, source: Source): Entry {
    const repairedUrl = this.genericHomepageMismatchTarget(item, source);
    return super.normalize(repairedUrl ? { ...item, url: repairedUrl, canonicalIdentity: repairedUrl } : item, source);
  }

  sync(context: SyncContext): Promise<SyncResult> {
    return this.fetchWithMetadata(context.source);
  }

  private genericHomepageMismatchTarget(item: RawEntry, source: Source): string | undefined {
    if (source.kind !== "generic" || !item.canonicalIdentity) return undefined;
    try {
      const sourceUrl = new URL(canonicalizeContentUrl(source.url));
      const itemUrl = new URL(canonicalizeContentUrl(item.url));
      const identityUrl = new URL(canonicalizeContentUrl(item.canonicalIdentity));
      if (itemUrl.toString() !== sourceUrl.toString()) return undefined;
      if (identityUrl.origin !== sourceUrl.origin || identityUrl.toString() === sourceUrl.toString()) return undefined;
      return identityUrl.toString();
    } catch {
      return undefined;
    }
  }

  async fetchWithMetadata(source: Source): Promise<FetchOutcome> {
    const needsLegacyRuleAudit = Boolean(source.extractionRule?.itemRootSelector && source.extractionRule.autoRepairRevision !== AUTOMATIC_RULE_REVISION);
    const needsPublicationDateAudit = source.extractionRule?.publicationDateRevision !== PUBLICATION_DATE_REVISION;
    const configuredFeedUrl = source.extractionRule?.feedUrl;
    if (configuredFeedUrl) return this.fetchDeclaredFeed(source, configuredFeedUrl);

    // Existing web sources were created before footer/feed-link discovery was
    // available. Replay each once even when the homepage validator says 304,
    // then persist either the verified Feed URL or the audit revision.
    const needsFeedDiscoveryAudit = source.extractionRule?.feedDiscoveryRevision !== FEED_DISCOVERY_REVISION;
    const page = await loadGenericPage(this.http, this.renderer, source.url, {
      cached: needsLegacyRuleAudit || needsPublicationDateAudit || needsFeedDiscoveryAudit
        ? undefined
        : { etag: source.etag, lastModified: source.lastModified },
      preferRenderer: source.extractionRule?.rendererRequired === true
    });
    if (page.response?.status === 304) return { entries: [], notModified: true, emptyIsHealthy: true };

    for (const feedUrl of discoverFeedUrls(page.text, page.url)) {
      try {
        const feedResponse = await this.http.getText(feedUrl);
        if (!looksLikeFeed(feedResponse.contentType, feedResponse.text)) continue;
        const feed = await parseFeed(feedResponse.text, feedResponse.url);
        if (!feed.entries.length) continue;
        return {
          entries: feed.entries,
          notModified: false,
          emptyIsHealthy: true,
          etag: feedResponse.etag,
          lastModified: feedResponse.lastModified,
          metadataRevision: RSS_METADATA_REVISION,
          iconUrl: feed.iconUrl,
          extractionRule: withFeedDiscoveryRevision({ version: 1, ...source.extractionRule, feedUrl: feedResponse.url })
        };
      } catch {
        // A candidate is only an optimisation. Preserve the working generic
        // path when it is malformed, unavailable, or robots-disallowed.
      }
    }

    const extraction = extractGenericPage(page.text, page.url, source.extractionRule);
    const entries = await this.enrichPublicationDates(extraction.entries);
    return {
      entries,
      notModified: false,
      emptyIsHealthy: entries.length > 0,
      etag: page.response?.etag,
      lastModified: page.response?.lastModified,
      // A metadata-only rule is safe: it does not constrain item detection,
      // but records that existing entries have been replayed by this parser.
      extractionRule: withFeedDiscoveryRevision(withPublicationDateRevision(withRendererRequirement(
        extraction.rule ?? source.extractionRule,
        page.fromRenderer
      )))
    };
  }

  /**
   * Homepage cards frequently omit a machine-readable date even though the
   * linked public article has one. Enrich only missing records, keeping the
   * normal robots-aware HTTP policy and never persisting fetched page bodies.
   */
  private async enrichPublicationDates(entries: RawEntry[]): Promise<RawEntry[]> {
    const missing = entries.filter((entry) => entry.publishedAt === undefined);
    const dates = new Map<string, number>();
    const unresolved: RawEntry[] = [];
    for (const entry of missing) {
      const date = extractPublicationDateFromUrl(entry.url);
      if (date !== undefined) dates.set(entry.url, date);
      else unresolved.push(entry);
    }

    // A page normally exposes only the recent archive. The cap bounds a
    // manual refresh even when a site happens to present a very large list.
    for (const entry of unresolved.slice(0, 32)) {
      try {
        const response = await this.http.getText(entry.url, undefined, { maxBytes: 1_500_000 });
        const date = extractPagePublishedAt(load(response.text));
        if (date !== undefined) dates.set(entry.url, date);
      } catch {
        // A missing date must not make a healthy source fail. The next normal
        // refresh can retry while preserving the original entry.
      }
    }

    return entries.map((entry) => {
      const publishedAt = entry.publishedAt ?? dates.get(entry.url);
      return publishedAt === undefined ? entry : { ...entry, publishedAt };
    });
  }

  private async fetchDeclaredFeed(source: Source, feedUrl: string): Promise<FetchOutcome> {
    // A generic source that later graduated to a Feed still needs the same
    // one-time metadata replays as a direct RSS subscription. Otherwise an
    // ETag 304 would leave legacy card fields (and filtered navigation links)
    // untouched indefinitely.
    const needsMetadataReplay = source.metadataRevision !== RSS_METADATA_REVISION;
    const response = await this.http.getText(feedUrl, needsMetadataReplay ? undefined : { etag: source.etag, lastModified: source.lastModified });
    if (response.status === 304) return { entries: [], notModified: true, emptyIsHealthy: true };
    if (!looksLikeFeed(response.contentType, response.text)) throw new Error("来源声明的 Feed 已不再是有效订阅，请重新校准该来源。");
    const feed = await parseFeed(response.text, response.url);
    return {
      entries: feed.entries,
      notModified: false,
      emptyIsHealthy: true,
      etag: response.etag,
      lastModified: response.lastModified,
      metadataRevision: RSS_METADATA_REVISION,
      iconUrl: feed.iconUrl,
      extractionRule: withFeedDiscoveryRevision({ version: 1, ...source.extractionRule, feedUrl: response.url })
    };
  }
}

function withFeedDiscoveryRevision(rule?: ExtractionRule): ExtractionRule {
  const base = rule ?? { version: 1 };
  return base.feedDiscoveryRevision === FEED_DISCOVERY_REVISION ? base : { ...base, feedDiscoveryRevision: FEED_DISCOVERY_REVISION };
}

function withRendererRequirement(rule: ExtractionRule | undefined, required: boolean): ExtractionRule | undefined {
  if (!required) return rule;
  return { version: 1, ...rule, rendererRequired: true };
}

/** Manual sources are fetched only when first saved or when the user explicitly refreshes. */
export class ManualConnector extends GenericConnector {
  override readonly manifest = builtInManifest("manual", "分享链接", ["public-http"], []);
}
