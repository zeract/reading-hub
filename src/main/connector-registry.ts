import type {
  ConnectorAdapter,
  ConnectorId,
  ConnectorManifest,
  NormalizedEntry,
  RawEntry,
  Source,
  SyncContext,
  SyncResult
} from "../shared/types";

/**
 * The only connector loading mechanism in v1. Adapters are compiled into the
 * app and registered explicitly; this gives providers an extension point
 * without letting remote or third-party code obtain filesystem, database, or
 * credential access.
 */
export class ConnectorRegistry {
  private readonly adapters = new Map<ConnectorId, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): void {
    const id = adapter.manifest.id;
    if (!adapter.manifest.builtIn) throw new Error("当前版本只允许注册内置连接器。");
    if (this.adapters.has(id)) throw new Error(`连接器 ${id} 已注册。`);
    this.adapters.set(id, adapter);
  }

  get(id: ConnectorId): ConnectorAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`未找到连接器：${id}`);
    return adapter;
  }

  has(id: ConnectorId): boolean {
    return this.adapters.has(id);
  }

  manifests(): ConnectorManifest[] {
    return [...this.adapters.values()].map((adapter) => adapter.manifest);
  }
}

export type LegacyFetchOutcome = {
  entries: RawEntry[];
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
  extractionRule?: Source["extractionRule"];
  metadataRevision?: number;
  iconUrl?: string;
};

/** Adapts the existing safe RSS/web/manual pipeline to the new host contract. */
export class LegacyConnectorAdapter implements ConnectorAdapter {
  constructor(
    public readonly manifest: ConnectorManifest,
    private readonly fetcher: (source: Source) => Promise<LegacyFetchOutcome>,
    private readonly normalizer: (item: RawEntry, source: Source) => NormalizedEntry
  ) {}

  async sync(context: SyncContext): Promise<SyncResult> {
    const outcome = await this.fetcher(context.source);
    return {
      entries: outcome.entries,
      etag: outcome.etag,
      lastModified: outcome.lastModified,
      notModified: outcome.notModified,
      extractionRule: outcome.extractionRule,
      metadataRevision: outcome.metadataRevision,
      iconUrl: outcome.iconUrl
    };
  }

  normalize(item: RawEntry, source: Source): NormalizedEntry {
    return this.normalizer(item, source);
  }
}

/** For first-party providers whose session or API client lives outside Source. */
export class CallbackConnectorAdapter implements ConnectorAdapter {
  constructor(
    public readonly manifest: ConnectorManifest,
    private readonly synchronizer: (context: SyncContext) => Promise<SyncResult>,
    private readonly normalizer: (item: RawEntry, source: Source) => NormalizedEntry
  ) {}

  sync(context: SyncContext): Promise<SyncResult> {
    return this.synchronizer(context);
  }

  normalize(item: RawEntry, source: Source): NormalizedEntry {
    return this.normalizer(item, source);
  }
}

export function builtInManifest(
  id: ConnectorId,
  displayName: string,
  capabilities: ConnectorManifest["capabilities"],
  allowedHosts: string[],
  requiresAccount = false
): ConnectorManifest {
  return { id, version: 1, displayName, builtIn: true, capabilities, allowedHosts, requiresAccount };
}
