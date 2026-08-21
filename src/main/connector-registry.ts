import type {
  ConnectorAdapter,
  ConnectorId,
  ConnectorManifest
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

export function builtInManifest(
  id: ConnectorId,
  displayName: string,
  capabilities: ConnectorManifest["capabilities"],
  allowedHosts: string[],
  requiresAccount = false
): ConnectorManifest {
  return { id, version: 1, displayName, builtIn: true, capabilities, allowedHosts, requiresAccount };
}
