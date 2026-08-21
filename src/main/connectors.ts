import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import type { Connector, Entry, ExtractionRule, ProbeResult, RawEntry, Source } from "../shared/types";
import { canonicalizeContentUrl, contentHash, isTrustedLoopbackFeedUrl } from "../shared/url";
import { AUTOMATIC_RULE_REVISION, PUBLICATION_DATE_REVISION, extractGenericPage, extractPagePublishedAt, extractPublicationDateFromUrl, withPublicationDateRevision } from "./extractor";
import { discoverFeedUrls, FEED_DISCOVERY_REVISION, looksLikeFeed, parseFeed, RSS_METADATA_REVISION } from "./feed";
import { PublicHttpClient } from "./http";
import type { PageRenderer } from "./page-renderer";
import { SourceProbe } from "./source-probe";

export interface FetchOutcome {
  entries: RawEntry[];
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  extractionRule?: ExtractionRule;
  metadataRevision?: number;
}

abstract class BaseConnector implements Connector {
  constructor(protected readonly http: PublicHttpClient, protected readonly probeService: SourceProbe) {}

  abstract probe(url: string): Promise<ProbeResult>;
  abstract fetch(source: Source): Promise<RawEntry[]>;

  normalize(item: RawEntry, source: Source): Entry {
    const canonicalUrl = canonicalizeContentUrl(item.url);
    const now = Date.now();
    return {
      ...item,
      id: randomUUID(),
      sourceId: source.id,
      canonicalUrl,
      canonicalIdentity: item.canonicalIdentity ?? canonicalUrl,
      contentHash: contentHash(item),
      read: false,
      favorite: false,
      createdAt: now,
      observedAt: item.observedAt ?? now,
      providerId: item.providerId ?? source.connectorId ?? source.kind,
      providerLabel: item.providerLabel
    };
  }
}

export class RssConnector extends BaseConnector {
  async probe(url: string): Promise<ProbeResult> {
    const result = await this.probeService.probe(url);
    if (result.kind !== "rss") throw new Error("该地址没有发现可用 Feed。");
    return result;
  }

  async fetch(source: Source): Promise<RawEntry[]> {
    return (await this.fetchWithMetadata(source)).entries;
  }

  async fetchWithMetadata(source: Source): Promise<FetchOutcome> {
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
    if (response.status === 304) return { entries: [], notModified: true };
    return {
      entries: (await parseFeed(response.text, response.url)).entries,
      notModified: false,
      etag: response.etag,
      lastModified: response.lastModified,
      metadataRevision: RSS_METADATA_REVISION
    };
  }
}

export class GenericConnector extends BaseConnector {
  constructor(http: PublicHttpClient, probeService: SourceProbe, private readonly renderer?: PageRenderer) {
    super(http, probeService);
  }

  async probe(url: string): Promise<ProbeResult> {
    const result = await this.probeService.probe(url);
    if (result.kind !== "generic") throw new Error("该地址优先使用 Feed 或手动导入。");
    return result;
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

  async fetch(source: Source): Promise<RawEntry[]> {
    return (await this.fetchWithMetadata(source)).entries;
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
    const response = source.extractionRule?.rendererRequired && this.renderer
      ? { url: source.url, text: await this.renderer.render(source.url) }
      : await this.http.getText(source.url, needsLegacyRuleAudit || needsPublicationDateAudit || needsFeedDiscoveryAudit ? undefined : { etag: source.etag, lastModified: source.lastModified });
    if ("status" in response && response.status === 304) return { entries: [], notModified: true };

    for (const feedUrl of discoverFeedUrls(response.text, response.url)) {
      try {
        const feedResponse = await this.http.getText(feedUrl);
        if (!looksLikeFeed(feedResponse.contentType, feedResponse.text)) continue;
        const feed = await parseFeed(feedResponse.text, feedResponse.url);
        if (!feed.entries.length) continue;
        return {
          entries: feed.entries,
          notModified: false,
          etag: feedResponse.etag,
          lastModified: feedResponse.lastModified,
          metadataRevision: RSS_METADATA_REVISION,
          extractionRule: withFeedDiscoveryRevision({ version: 1, ...source.extractionRule, feedUrl: feedResponse.url })
        };
      } catch {
        // A candidate is only an optimisation. Preserve the working generic
        // path when it is malformed, unavailable, or robots-disallowed.
      }
    }

    const extraction = extractGenericPage(response.text, response.url, source.extractionRule);
    const entries = await this.enrichPublicationDates(extraction.entries);
    return {
      entries,
      notModified: false,
      etag: "etag" in response ? response.etag : undefined,
      lastModified: "lastModified" in response ? response.lastModified : undefined,
      // A metadata-only rule is safe: it does not constrain item detection,
      // but records that existing entries have been replayed by this parser.
      extractionRule: withFeedDiscoveryRevision(withPublicationDateRevision(extraction.rule ?? source.extractionRule))
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
    if (response.status === 304) return { entries: [], notModified: true };
    if (!looksLikeFeed(response.contentType, response.text)) throw new Error("来源声明的 Feed 已不再是有效订阅，请重新校准该来源。");
    const feed = await parseFeed(response.text, response.url);
    return {
      entries: feed.entries,
      notModified: false,
      etag: response.etag,
      lastModified: response.lastModified,
      metadataRevision: RSS_METADATA_REVISION,
      extractionRule: withFeedDiscoveryRevision({ version: 1, ...source.extractionRule, feedUrl: response.url })
    };
  }
}

function withFeedDiscoveryRevision(rule?: ExtractionRule): ExtractionRule {
  const base = rule ?? { version: 1 };
  return base.feedDiscoveryRevision === FEED_DISCOVERY_REVISION ? base : { ...base, feedDiscoveryRevision: FEED_DISCOVERY_REVISION };
}

/** Manual sources are fetched only when first saved or when the user explicitly refreshes. */
export class ManualConnector extends GenericConnector {
  async probe(url: string): Promise<ProbeResult> {
    const result = await this.probeService.probe(url);
    return { ...result, kind: "manual", message: "仅保存此分享链接，不会自动轮询。" };
  }
}
