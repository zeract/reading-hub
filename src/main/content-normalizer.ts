import { randomUUID } from "node:crypto";
import type { ConnectorId, Entry, RawEntry, Source } from "../shared/types";
import { canonicalizeContentUrl } from "../shared/url";
import { contentHash, identityContentHash } from "./content-hash";

type Canonicalizer = (url: string) => string;
type IdentityResolver = (item: RawEntry, canonicalUrl: string) => string;
type CanonicalUrlResolver = (item: RawEntry, canonicalIdentity: string, defaultCanonicalUrl: string) => string;
type ProviderIdResolver = (item: RawEntry, source: Source) => ConnectorId;
type ProviderLabelResolver = (item: RawEntry, source: Source) => string | undefined;

export interface ContentNormalizationOptions {
  /**
   * Default content canonicalisation removes tracking data and normalises the
   * Scour RSS redirect wrapper. Providers with a stable URL namespace may
   * deliberately supply a narrower policy.
   */
  canonicalizeUrl?: Canonicalizer;
  /** Resolves a provider's stable cross-source identity. */
  canonicalIdentity?: IdentityResolver;
  /** Lets a provider derive its reader URL from a resolved identity (for DOI). */
  canonicalUrl?: CanonicalUrlResolver;
  /** Default hashes visible metadata; identity mode includes provider identity. */
  hashMode?: "metadata" | "identity";
  /** Overrides generic source provenance when a connector owns every record. */
  providerId?: ConnectorId | ProviderIdResolver;
  /** Overrides generic provenance labels when a connector owns every record. */
  providerLabel?: string | ProviderLabelResolver;
}

/**
 * The single main-process path that turns connector output into a database
 * entry. Connectors only map provider data into RawEntry and declare the few
 * identity differences that are intrinsic to their platform.
 *
 * This module intentionally stays in the main process: IDs and hashes are
 * persistence concerns and must not be bundled into the renderer.
 */
export class ContentNormalizer {
  normalize(item: RawEntry, source: Source, options: ContentNormalizationOptions = {}): Entry {
    const defaultCanonicalUrl = (options.canonicalizeUrl ?? canonicalizeContentUrl)(item.url);
    const canonicalIdentity = (options.canonicalIdentity ?? defaultIdentity)(item, defaultCanonicalUrl);
    const canonicalUrl = (options.canonicalUrl ?? defaultCanonicalUrlResolver)(item, canonicalIdentity, defaultCanonicalUrl);
    const now = Date.now();
    const providerId = resolveProviderId(options.providerId, item, source);
    const providerLabel = resolveProviderLabel(options.providerLabel, item, source);

    return {
      ...item,
      id: randomUUID(),
      sourceId: source.id,
      canonicalUrl,
      canonicalIdentity,
      contentHash: options.hashMode === "identity" ? identityContentHash(canonicalIdentity, item) : contentHash(item),
      read: false,
      favorite: false,
      createdAt: now,
      observedAt: item.observedAt ?? now,
      providerId,
      providerLabel
    };
  }
}

export const contentNormalizer = new ContentNormalizer();

function defaultIdentity(item: RawEntry, canonicalUrl: string): string {
  return item.canonicalIdentity ?? canonicalUrl;
}

function defaultCanonicalUrlResolver(_item: RawEntry, _canonicalIdentity: string, canonicalUrl: string): string {
  return canonicalUrl;
}

function resolveProviderId(
  resolver: ContentNormalizationOptions["providerId"],
  item: RawEntry,
  source: Source
): ConnectorId {
  if (typeof resolver === "function") return resolver(item, source);
  return resolver ?? item.providerId ?? source.connectorId ?? source.kind;
}

function resolveProviderLabel(
  resolver: ContentNormalizationOptions["providerLabel"],
  item: RawEntry,
  source: Source
): string | undefined {
  if (typeof resolver === "function") return resolver(item, source);
  return resolver ?? item.providerLabel;
}
