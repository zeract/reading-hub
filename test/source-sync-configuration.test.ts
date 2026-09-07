import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { contentNormalizer } from "../src/main/content-normalizer";
import { SourceService } from "../src/main/source-service";
import { SyncManager } from "../src/main/sync-manager";
import type { SyncContext, SyncResult } from "../src/shared/types";

function fixture(kind: "rss" | "generic" = "rss") {
  const db = new ReadingDatabase(":memory:");
  const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind, pollingEnabled: true });
  const calls: Array<{ context: SyncContext; resolve(value: SyncResult): void; reject(reason: Error): void }> = [];
  const registry = new ConnectorRegistry();
  for (const id of ["rss", "generic"] as const) registry.register({
    manifest: { id, version: 1, displayName: "Fixture", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
    sync: (context) => new Promise<SyncResult>((resolve, reject) => { calls.push({ context, resolve, reject }); }),
    normalize: (entry, source) => contentNormalizer.normalize(entry, source)
  });
  const sync = new SyncManager(db, registry);
  const service = new SourceService(db, {} as never, sync, {} as never);
  const outcome = { entries: [{ url: "https://example.com/old", title: "Old response" }], checkpoint: { cursor: "old" } };
  return { db, source, calls, sync, service, outcome };
}

describe("source configuration and active synchronization", () => {
  it("preserves a refresh across presentation changes and equivalent category selections", async () => {
    const { db, source, calls, sync, service, outcome } = fixture();
    const facets = [{ scheme: "fixture", key: "a", label: "A" }, { scheme: "fixture", key: "b", label: "B" }];
    db.updateSubscriptionScope(source.id, { facetSelections: facets, history: { mode: "none" } });
    const pending = sync.syncSource(source.id);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      service.updateSettings(source.id, { title: "Renamed", category: "Folder", kind: "rss", pollingEnabled: true, refreshIntervalMinutes: 60 });
      service.updateCollectionScope(source.id, { facetSelections: [...facets].reverse().map((facet) => ({ ...facet, label: `Renamed ${facet.label}` })), history: { mode: "none" } });
      expect(calls[0].context.signal?.aborted).toBe(false);
      calls[0].resolve({ ...outcome, entries: outcome.entries.map((entry) => ({ ...entry, facets })) });
      expect((await pending).inserted).toBe(1);
      expect(db.getSource(source.id)).toMatchObject({ title: "Renamed", category: "Folder", refreshIntervalMinutes: 60 });
    } finally { calls[0]?.resolve(outcome); await Promise.allSettled([pending]); await sync.close(); db.close(); }
  });

  it("cancels an explicit calibration reset even when its rule is unchanged", async () => {
    const { db, source, calls, sync, service, outcome } = fixture("generic");
    const rule = { version: 1 as const, itemRootSelector: "article", titleSelector: "a" };
    db.updateRule(source.id, rule);
    const pending = sync.syncSource(source.id).catch((error) => error);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      service.updateRule(source.id, rule);
      expect(calls[0].context.signal?.aborted).toBe(true);
      calls[0].resolve(outcome);
      expect((await pending).message).toContain("已取消");
      expect(db.listEntries()).toEqual([]);
    } finally { calls[0]?.resolve(outcome); await pending; await sync.close(); db.close(); }
  });

  it.each(["settings", "scope", "rule", "subscription"])("does not cancel an active refresh when the %s write fails", async (change) => {
    const { db, source, calls, sync, service, outcome } = fixture();
    const pending = sync.syncSource(source.id);
    let write: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const method = { settings: "updateSourceSettings", scope: "updateSubscriptionScope", rule: "updateRule", subscription: "setSubscribed" }[change]!;
      write = vi.spyOn(db as any, method).mockImplementationOnce(() => { throw new Error("synthetic write failure"); });
      const update = () => {
        if (change === "settings") return service.updateSettings(source.id, { title: "Changed", kind: "rss", pollingEnabled: false });
        if (change === "scope") return service.updateCollectionScope(source.id, { facetSelections: [], history: { mode: "all" } });
        if (change === "rule") return service.updateRule(source.id, { version: 1, titleSelector: "a" });
        return service.setSubscribed(source.id, false);
      };
      if (change === "subscription") await expect(update()).rejects.toThrow("synthetic write failure");
      else expect(update).toThrow("synthetic write failure");
      expect(calls[0].context.signal?.aborted).toBe(false);
      calls[0].resolve(outcome);
      expect((await pending).inserted).toBe(1);
    } finally { write?.mockRestore(); calls[0]?.resolve(outcome); await Promise.allSettled([pending]); await sync.close(); db.close(); }
  });

  it.each(["pause", "kind", "scope"].flatMap((change) => [false, true].map((failed) => [change, failed] as const)))("cancels a %s change even if restored (late failure: %s)", async (change, failed) => {
    const { db, source, calls, sync, service, outcome } = fixture();
    const pending = sync.syncSource(source.id).catch((error) => error);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const settings = { title: source.title, kind: source.kind, pollingEnabled: true };
      if (change === "scope") {
        service.updateCollectionScope(source.id, { facetSelections: [], history: { mode: "all" } });
        service.updateCollectionScope(source.id, { facetSelections: [], history: { mode: "none" } });
      } else {
        service.updateSettings(source.id, { ...settings, kind: change === "kind" ? "generic" : source.kind, pollingEnabled: change !== "pause" });
        service.updateSettings(source.id, settings);
      }
      expect(calls[0].context.signal?.aborted).toBe(true);
      if (failed) calls[0].reject(new Error("synthetic late network failure"));
      else calls[0].resolve(outcome);
      expect((await pending).message).toContain("已取消");
      expect(db.listEntries()).toEqual([]);
      expect(db.getCheckpoint(db.getSubscriptionForSource(source.id)!.id)).toBeUndefined();
      expect(db.getSource(source.id)?.failureCount).toBe(0);
    } finally { calls[0]?.resolve(outcome); await pending; await sync.close(); db.close(); }
  });

  it("removes a cancelled configuration from the same-host queue before network work starts", async () => {
    const { db, source, calls, sync, service, outcome } = fixture();
    const second = db.createSource({ url: "https://example.com/second", title: "Second", kind: "rss", pollingEnabled: true });
    const firstRun = sync.syncSource(source.id);
    const secondRun = sync.syncSource(second.id).catch((error) => error);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      service.updateCollectionScope(second.id, { facetSelections: [], history: { mode: "all" } });
      expect((await secondRun).message).toContain("已取消");
      expect(calls).toHaveLength(1);
      expect(db.getSource(second.id)?.failureCount).toBe(0);
    } finally { calls[0]?.resolve(outcome); await Promise.allSettled([firstRun, secondRun]); await sync.close(); db.close(); }
  });
});
