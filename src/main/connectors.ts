import { randomUUID } from "node:crypto";
import type { Connector, Entry, ExtractionRule, ProbeResult, RawEntry, Source } from "../shared/types";
import { canonicalizeUrl, contentHash } from "../shared/url";
import { AUTOMATIC_RULE_REVISION, extractGenericPage } from "./extractor";
import { parseFeed } from "./feed";
import { PublicHttpClient } from "./http";
import type { PageRenderer } from "./page-renderer";
import { SourceProbe } from "./source-probe";

export interface FetchOutcome {
  entries: RawEntry[];
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  extractionRule?: ExtractionRule;
}

abstract class BaseConnector implements Connector {
  constructor(protected readonly http: PublicHttpClient, protected readonly probeService: SourceProbe) {}

  abstract probe(url: string): Promise<ProbeResult>;
  abstract fetch(source: Source): Promise<RawEntry[]>;

  normalize(item: RawEntry, source: Source): Entry {
    const canonicalUrl = canonicalizeUrl(item.url);
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
    const response = await this.http.getText(source.url, { etag: source.etag, lastModified: source.lastModified });
    if (response.status === 304) return { entries: [], notModified: true };
    return {
      entries: (await parseFeed(response.text, response.url)).entries,
      notModified: false,
      etag: response.etag,
      lastModified: response.lastModified
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

  async fetch(source: Source): Promise<RawEntry[]> {
    return (await this.fetchWithMetadata(source)).entries;
  }

  async fetchWithMetadata(source: Source): Promise<FetchOutcome> {
    const needsLegacyRuleAudit = source.extractionRule && source.extractionRule.autoRepairRevision !== AUTOMATIC_RULE_REVISION;
    const response = source.extractionRule?.rendererRequired && this.renderer
      ? { url: source.url, text: await this.renderer.render(source.url) }
      : await this.http.getText(source.url, needsLegacyRuleAudit ? undefined : { etag: source.etag, lastModified: source.lastModified });
    if ("status" in response && response.status === 304) return { entries: [], notModified: true };
    const extraction = extractGenericPage(response.text, response.url, source.extractionRule);
    return {
      entries: extraction.entries,
      notModified: false,
      etag: "etag" in response ? response.etag : undefined,
      lastModified: "lastModified" in response ? response.lastModified : undefined,
      extractionRule: extraction.rule
    };
  }
}

/** Manual sources are fetched only when first saved or when the user explicitly refreshes. */
export class ManualConnector extends GenericConnector {
  async probe(url: string): Promise<ProbeResult> {
    const result = await this.probeService.probe(url);
    return { ...result, kind: "manual", message: "仅保存此分享链接，不会自动轮询。" };
  }
}
