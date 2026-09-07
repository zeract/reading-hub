import { expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { contentNormalizer } from "../src/main/content-normalizer";
import { SyncManager } from "../src/main/sync-manager";

it("prepares one collection scope for a large sync batch", async () => {
  const db = new ReadingDatabase(":memory:");
  const registry = new ConnectorRegistry();
  const manager = new SyncManager(db, registry);
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
    const selections = Array.from({ length: 64 }, (_, index) => ({ scheme: "fixture", key: String(index), label: `Topic ${index}` }));
    db.updateSubscriptionScope(source.id, { facetSelections: selections, history: { mode: "none" } });
    const subscription = db.getSubscriptionForSource(source.id)!;
    let scopeReads = 0;
    Object.defineProperty(subscription.scope, "facetSelections", { get() { scopeReads++; return selections; } });
    const readSubscription = vi.spyOn(db, "getSubscriptionForSource").mockReturnValueOnce(subscription);
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "Fixture", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        return { entries: Array.from({ length: 5_000 }, (_, index) => ({
          url: `https://example.com/${index}`, title: `Fixture ${index}`,
          facets: index % 2 ? [{ ...selections[0], scheme: "other-publisher" }] : [selections[index % 64]]
        })), checkpoint: { cursor: "next-batch" }, emptyIsHealthy: true };
      },
      normalize: (entry, current) => contentNormalizer.normalize(entry, current)
    });
    const result = await manager.syncSource(source.id);
    readSubscription.mockRestore();
    expect(result.inserted).toBe(2_500);
    expect(db.listEntries({ limit: 5_000 })).toHaveLength(2_500);
    expect(db.getCheckpoint(source.id)?.cursor).toBe("next-batch");
    // Configuration consistency checks may inspect the snapshot too, but
    // adding records must not add one scope normalization per record.
    expect(scopeReads).toBeLessThan(10);
  } finally { vi.restoreAllMocks(); await manager.close(); db.close(); }
});
