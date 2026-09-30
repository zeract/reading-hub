import { CONTENT_IDENTITY_NAMESPACES } from "../shared/types";
import type {
  ConnectorAdapter,
  ConnectorId,
  ConnectorManifest,
  ContentIdentityNamespace
} from "../shared/types";

// Provider-issued IDs belong to one authority. Standard DOI/arXiv IDs are
// intentionally shared; adding another provider namespace requires review.
const PROVIDER_IDENTITY_OWNERS: Partial<Record<ContentIdentityNamespace, ConnectorId>> = {
  openalex: "academic",
  semantic: "academic",
  orcid: "academic",
  x: "x",
  xiaohongshu: "xiaohongshu"
};

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
    if (adapter.manifest.identityNamespaces?.some((namespace) => !CONTENT_IDENTITY_NAMESPACES.includes(namespace))) {
      throw new Error("连接器声明了未知的内容身份命名空间。");
    }
    if (adapter.manifest.identityNamespaces?.some((namespace) =>
      PROVIDER_IDENTITY_OWNERS[namespace] && PROVIDER_IDENTITY_OWNERS[namespace] !== id)) {
      throw new Error("连接器不能声明其他提供方拥有的内容身份命名空间。");
    }
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
  policy: Pick<ConnectorManifest, "requiresAccount" | "entryPolicy" | "identityNamespaces"> = {}
): ConnectorManifest {
  return { id, version: 1, displayName, builtIn: true, ...policy };
}
