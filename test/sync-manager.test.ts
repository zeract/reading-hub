import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ContentMaintenance } from "../src/main/content-maintenance";
import { ReadingDatabase } from "../src/main/database";
import { SyncCancelledError, SyncManager } from "../src/main/sync-manager";
import type { ConnectorAdapter, Entry, RawEntry, Source } from "../src/shared/types";

describe("SyncManager", () => {
  it("starts a fresh refresh after a cancelled predecessor drains", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const registry = new ConnectorRegistry();
    const gate = deferred();
    let calls = 0;
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        calls += 1;
        if (calls === 1) { gate.started(); await gate.wait; }
        return { entries: [{ url: "https://example.com/new", title: "Fresh" }], emptyIsHealthy: true };
      },
      normalize(item, current) { return readerEntry(current, item); }
    });
    const manager = new SyncManager(db, registry);
    try {
      const first = manager.syncSource(source.id);
      const cancelled = expect(first).rejects.toBeInstanceOf(SyncCancelledError);
      await gate.startedPromise;
      manager.cancelSource(source.id);
      const retried = manager.syncSource(source.id);
      gate.release();
      await cancelled;
      await expect(retried).resolves.toMatchObject({ inserted: 1 });
      expect(calls).toBe(2);
      expect(db.listSyncEvents()).toHaveLength(1);
    } finally { await manager.close(); db.close(); }
  });

  it("writes an adapter metadata revision and backfills an existing card on replay", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed.xml", title: "Example", kind: "rss", pollingEnabled: true });
    const url = "https://example.com/post";
    const now = Date.now();
    const oldEntry = readerEntry(source, { url, title: "Dated post", createdAt: now });
    db.saveEntries([oldEntry]);

    const registry = new ConnectorRegistry();
    registry.register(replayAdapter());
    const result = await new SyncManager(db, registry).syncSource(source.id);

    expect(result.source.metadataRevision).toBe(1);
    expect(result.source.iconUrl).toBe("https://example.com/feed-icon.png");
    expect(result.inserted).toBe(0);
    expect(db.listEntries(source.id)).toEqual([expect.objectContaining({ publishedAt: Date.UTC(2024, 1, 4) })]);
    db.close();
  });

  it("records failed background syncs without rejecting the scheduler and limits startup fan-out", async () => {
    const db = new ReadingDatabase(":memory:");
    const sources = ["one", "two", "three"].map((host) => db.createSource({
      url: `https://${host}.example.com/feed.xml`,
      title: host,
      kind: "rss",
      pollingEnabled: true
    }));
    const registry = new ConnectorRegistry();
    let active = 0;
    let peak = 0;
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        throw new Error("无法连接到该站点。请检查网络或系统代理设置后重试。");
      },
      normalize(item: RawEntry, source: Source): Entry {
        return readerEntry(source, item);
      }
    });
    const manager = new SyncManager(db, registry);

    await expect(manager.runDue()).resolves.toBeUndefined();
    expect(peak).toBe(2);
    for (const source of sources) {
      expect(db.getSource(source.id)).toEqual(expect.objectContaining({
        status: "error",
        failureCount: 1,
        lastError: "无法连接到该站点。请检查网络或系统代理设置后重试。"
      }));
      expect(db.listSyncEvents(source.id)).toEqual([expect.objectContaining({ outcome: "failure" })]);
    }
    await expect(manager.syncSource(sources[0].id)).rejects.toThrow("无法连接到该站点。请检查网络或系统代理设置后重试。");
    db.close();
  });

  it("uses connector-declared empty-result health instead of a source-kind branch", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({
      url: "https://provider.example/updates", title: "Provider", kind: "generic", connectorId: "provider-test", pollingEnabled: true
    });
    const registry = new ConnectorRegistry();
    registry.register({
      manifest: { id: "provider-test", version: 1, displayName: "Provider", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() { return { entries: [], emptyIsHealthy: false }; },
      normalize(item: RawEntry, currentSource: Source): Entry { return readerEntry(currentSource, item); }
    });
    const manager = new SyncManager(db, registry);

    await manager.syncSource(source.id);
    expect(db.getSource(source.id)).toMatchObject({ consecutiveEmpty: 1, status: "active" });
    await manager.syncSource(source.id);
    await manager.syncSource(source.id);
    expect(db.getSource(source.id)).toMatchObject({ consecutiveEmpty: 3, status: "needs_review" });
    db.close();
  });

  it("applies one shared category scope before persistence while preserving a healthy checkpoint", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const selected = { scheme: "feed:https://example.com:category", key: "systems", label: "Systems" };
    db.updateSubscriptionScope(source.id, { facetSelections: [selected], history: { mode: "none" } });
    const registry = new ConnectorRegistry();
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        return {
          entries: [
            { url: "https://example.com/systems", title: "Systems", facets: [selected] },
            { url: "https://example.com/ml", title: "ML", facets: [{ scheme: selected.scheme, key: "ml", label: "ML" }] }
          ],
          checkpoint: { cursor: "next-page" },
          emptyIsHealthy: true
        };
      },
      normalize(item: RawEntry, currentSource: Source): Entry { return readerEntry(currentSource, item); }
    });

    const result = await new SyncManager(db, registry).syncSource(source.id);

    expect(result).toMatchObject({ inserted: 1, source: { status: "active" } });
    expect(db.listEntries(source.id).map((entry) => entry.title)).toEqual(["Systems"]);
    expect(db.getCheckpoint(db.getSubscriptionForSource(source.id)!.id)).toMatchObject({ cursor: "next-page" });
    expect(db.listSyncEvents(source.id)[0]).toMatchObject({ outcome: "success", fetchedCount: 2, insertedCount: 1 });
    db.close();
  });

  it("does not write a delayed refresh after its source is deleted", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const registry = new ConnectorRegistry();
    const gate = deferred();
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        gate.started();
        await gate.wait;
        return { entries: [{ url: "https://example.com/new", title: "Delayed" }], emptyIsHealthy: true };
      },
      normalize(item: RawEntry, currentSource: Source): Entry { return readerEntry(currentSource, item); }
    });
    const refreshing = new SyncManager(db, registry).syncSource(source.id);
    await gate.startedPromise;
    db.deleteSource(source.id);
    gate.release();

    await expect(refreshing).rejects.toBeInstanceOf(SyncCancelledError);
    expect(db.getSource(source.id)).toBeUndefined();
    expect(db.listEntries()).toEqual([]);
    db.close();
  });

  it("does not overwrite a user-calibrated extraction rule with an older response", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/", title: "Example", kind: "generic", pollingEnabled: true });
    const registry = new ConnectorRegistry();
    const gate = deferred();
    registry.register({
      manifest: { id: "generic", version: 1, displayName: "Web", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        gate.started();
        await gate.wait;
        return {
          entries: [{ url: "https://example.com/old", title: "Old extraction" }],
          extractionRule: { version: 1, itemRootSelector: ".old-card" },
          emptyIsHealthy: true
        };
      },
      normalize(item: RawEntry, currentSource: Source): Entry { return readerEntry(currentSource, item); }
    });
    const refreshing = new SyncManager(db, registry).syncSource(source.id);
    await gate.startedPromise;
    db.updateRule(source.id, { version: 1, itemRootSelector: ".new-card" });
    gate.release();

    await expect(refreshing).rejects.toBeInstanceOf(SyncCancelledError);
    expect(db.getSource(source.id)?.extractionRule).toEqual({ version: 1, itemRootSelector: ".new-card" });
    expect(db.listEntries(source.id)).toEqual([]);
    db.close();
  });

  it("does not persist an in-flight response after its collection scope changes", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const registry = new ConnectorRegistry();
    const gate = deferred();
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        gate.started();
        await gate.wait;
        return { entries: [{ url: "https://example.com/new", title: "Delayed" }], emptyIsHealthy: true };
      },
      normalize(item: RawEntry, currentSource: Source): Entry { return readerEntry(currentSource, item); }
    });
    const refreshing = new SyncManager(db, registry).syncSource(source.id);
    await gate.startedPromise;
    db.updateSubscriptionScope(source.id, {
      facetSelections: [{ scheme: "feed:https://example.com:category", key: "systems", label: "Systems" }],
      history: { mode: "none" }
    });
    gate.release();

    await expect(refreshing).rejects.toBeInstanceOf(SyncCancelledError);
    expect(db.listEntries(source.id)).toEqual([]);
    expect(db.getSource(source.id)).toMatchObject({ status: "active" });
    db.close();
  });

  it("does not revive a source explicitly paused while a sync was in flight", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
    const registry = new ConnectorRegistry();
    const gate = deferred();
    registry.register({
      manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
      async sync() {
        gate.started();
        await gate.wait;
        return { entries: [{ url: "https://example.com/new", title: "Delayed" }], emptyIsHealthy: true };
      },
      normalize(item: RawEntry, currentSource: Source): Entry { return readerEntry(currentSource, item); }
    });
    const refreshing = new SyncManager(db, registry).syncSource(source.id);
    await gate.startedPromise;
    db.pauseSource(source.id, "user paused");
    gate.release();

    await expect(refreshing).rejects.toBeInstanceOf(SyncCancelledError);
    expect(db.getSource(source.id)).toMatchObject({ status: "paused", pollingEnabled: false });
    expect(db.listEntries(source.id)).toEqual([]);
    db.close();
  });

  it("coalesces concurrent refreshes and releases the source after a failed attempt", async () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
      const registry = new ConnectorRegistry();
      const gate = deferred();
      const sync = vi.fn(async () => { gate.started(); await gate.wait; throw new Error("offline"); });
      registry.register({ ...replayAdapter(), sync });
      const manager = new SyncManager(db, registry);
      const first = manager.syncSource(source.id);
      const second = manager.syncSource(source.id);
      const attempts = Promise.allSettled([first, second]);
      await gate.startedPromise;
      gate.release();
      expect((await attempts).map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(db.getSource(source.id)?.failureCount).toBe(1);
      await expect(manager.syncSource(source.id)).rejects.toThrow("offline");
      expect(sync).toHaveBeenCalledTimes(2);
    } finally { db.close(); }
  });

  it("rolls back cards, replay metadata, maintenance and checkpoint when final persistence fails", async () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
      const registry = new ConnectorRegistry();
      registry.register({ ...replayAdapter(), async sync() {
        return { entries: [{ url: "https://example.com/new", title: "New" }], metadataRevision: 2,
          iconUrl: "https://example.com/icon.png", checkpoint: { cursor: "next" } };
      } });
      const event = vi.spyOn(db, "recordSyncEvent");
      event.mockImplementationOnce(() => { throw new Error("disk write failed"); });
      await expect(new SyncManager(db, registry, new ContentMaintenance(db)).syncSource(source.id)).rejects.toThrow("disk write failed");
      expect(db.listEntries(source.id)).toEqual([]);
      expect(db.getCheckpoint(db.getSubscriptionForSource(source.id)!.id)).toBeUndefined();
      expect(db.getSource(source.id)).toMatchObject({ status: "error", failureCount: 1 });
      expect(db.getSource(source.id)?.metadataRevision).toBeUndefined();
      expect(db.getSource(source.id)?.iconUrl).toBeUndefined();
      expect(db.getSourceMaintenanceRevision(source.id)).toBeUndefined();
      expect(db.listSyncEvents(source.id).map((event) => event.outcome)).toEqual(["failure"]);
    } finally { db.close(); }
  });

  it.each(["pause", "scope", "kind"] as const)("discards a delayed failure after a %s change", async (change) => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
      const registry = new ConnectorRegistry();
      const gate = deferred();
      registry.register({ ...replayAdapter(), async sync() { gate.started(); await gate.wait; throw new Error("old network failure"); } });
      const refreshing = new SyncManager(db, registry).syncSource(source.id);
      await gate.startedPromise;
      if (change === "pause") db.pauseSource(source.id, "User paused");
      if (change === "scope") db.updateSubscriptionScope(source.id, { facetSelections: [], history: { mode: "all" } });
      if (change === "kind") db.updateSourceSettings(source.id, { title: source.title, kind: "generic", pollingEnabled: true });
      const current = db.getSource(source.id);
      gate.release();
      await expect(refreshing).rejects.toBeInstanceOf(SyncCancelledError);
      expect(db.getSource(source.id)).toEqual(current);
      expect(db.listSyncEvents(source.id)).toEqual([]);
    } finally { db.close(); }
  });

  it("rejects a paused source before making any connector request", async () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
      db.pauseSource(source.id, "User paused");
      const registry = new ConnectorRegistry();
      const adapter = replayAdapter();
      const sync = vi.spyOn(adapter, "sync");
      registry.register(adapter);
      await expect(new SyncManager(db, registry).syncSource(source.id)).rejects.toBeInstanceOf(SyncCancelledError);
      expect(sync).not.toHaveBeenCalled();
    } finally { db.close(); }
  });


  it.each([false, true])("drains active work and cancels queued work on close (transport failure: %s)", async (fails) => {
    const db = new ReadingDatabase(":memory:");
    try {
      const first = db.createSource({ url: "https://example.com/one", title: "One", kind: "rss", pollingEnabled: true });
      const second = db.createSource({ url: "https://example.com/two", title: "Two", kind: "rss", pollingEnabled: true });
      const gate = deferred();
      const registry = new ConnectorRegistry();
      const sync = vi.fn(async () => {
        gate.started();
        await gate.wait;
        // Some built-in OAuth adapters also update account health. The DB
        // must stay open until the adapter actually returns, even on failure.
        expect(db.getSource(first.id)).toBeDefined();
        if (fails) throw new Error("late network failure");
        return { entries: [{ url: "https://example.com/new", title: "Late" }] };
      });
      registry.register({ ...replayAdapter(), sync });
      const manager = new SyncManager(db, registry);
      const outcomes = Promise.allSettled([manager.syncSource(first.id), manager.syncSource(second.id)]);
      await gate.startedPromise;
      let closed = false;
      const closing = manager.close();
      void closing.then(() => { closed = true; });
      expect(manager.close()).toBe(closing);
      await expect(manager.syncSource(first.id)).rejects.toBeInstanceOf(SyncCancelledError);
      expect(closed).toBe(false);
      gate.release();
      const settled = await outcomes;
      await closing;
      expect(settled).toEqual([
        expect.objectContaining({ status: "rejected", reason: expect.any(SyncCancelledError) }),
        expect.objectContaining({ status: "rejected", reason: expect.any(SyncCancelledError) })
      ]);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(db.listEntries()).toEqual([]);
      expect(db.listSyncEvents()).toEqual([]);
      const getSource = vi.spyOn(db, "getSource");
      await manager.runDue();
      await expect(manager.syncSource(first.id)).rejects.toBeInstanceOf(SyncCancelledError);
      expect(getSource).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("redacts transport credentials before persisting or returning an error", async () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
      const registry = new ConnectorRegistry();
      registry.register({ ...replayAdapter(), async sync() {
        throw new Error("failed https://example.com/feed?key=fixture-url-token Bearer fixture-bearer api_key=fixture-key");
      } });
      await expect(new SyncManager(db, registry).syncSource(source.id)).rejects.toThrow("[redacted]");
      const persisted = JSON.stringify([db.getSource(source.id), db.listSyncEvents(source.id)]);
      for (const value of ["fixture-url-token", "fixture-bearer", "fixture-key"]) expect(persisted).not.toContain(value);
    } finally { db.close(); }
  });


  it("recovers committed checkpoints and failure backoff after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-sync-test-"));
    const file = join(directory, "test.sqlite");
    let db = new ReadingDatabase(file);
    try {
      const source = db.createSource({ url: "https://example.com/feed", title: "Example", kind: "rss", pollingEnabled: true });
      const registry = new ConnectorRegistry();
      const adapter = replayAdapter();
      const sync = vi.spyOn(adapter, "sync").mockResolvedValue({
        entries: [
          { url: "https://example.com/new", title: "New", publishedAt: 200 },
          { url: "https://example.com/old", title: "Old", publishedAt: 100 }
        ], checkpoint: { cursor: "saved-page" }
      });
      registry.register(adapter);
      expect(await new SyncManager(db, registry).syncSource(source.id)).toMatchObject({ inserted: 2 });
      const entry = db.listEntries(source.id)[0];
      db.markRead(entry.id, true);
      db.markFavorite(entry.id, true);
      db.close();
      db = new ReadingDatabase(file);
      const manager = new SyncManager(db, registry);
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 0 });
      expect(sync.mock.calls[1][0].checkpoint).toMatchObject({ cursor: "saved-page" });
      expect(db.listEntries(source.id).map((entry) => entry.title)).toEqual(["New", "Old"]);
      expect(db.getEntry(entry.id)).toMatchObject({ read: true, favorite: true });
      sync.mockRejectedValue(new Error("offline"));
      await expect(manager.syncSource(source.id)).rejects.toThrow("offline");
      const failed = db.getSource(source.id)!;
      expect(failed.nextCheckAt).toBeGreaterThan(Date.now());
      db.close();
      db = new ReadingDatabase(file);
      expect(db.getSource(source.id)).toEqual(failed);
      expect(db.listDueSources()).toEqual([]);
      expect(db.listDueSources(failed.nextCheckAt! + 1).map((source) => source.id)).toEqual([source.id]);
      expect(db.getCheckpoint(db.getSubscriptionForSource(source.id)!.id)).toMatchObject({ cursor: "saved-page" });
    } finally { db.close(); rmSync(directory, { recursive: true }); }
  });


  it("rechecks a queued scheduler snapshot after a manual refresh advances its deadline", async () => {
    const db = new ReadingDatabase(":memory:");
    try {
      const sources = ["one", "two", "three"].map((host) => db.createSource({
        url: `https://${host}.example.com/feed`, title: host, kind: "rss", pollingEnabled: true
      }));
      const registry = new ConnectorRegistry();
      const gate = deferred();
      let waiting = 0;
      const sync = vi.fn(async ({ source }: { source: Source }) => {
        if (source.id !== sources[2].id) { waiting += 1; if (waiting === 2) gate.started(); await gate.wait; }
        return { entries: [], emptyIsHealthy: true };
      });
      registry.register({ ...replayAdapter(), sync });
      const manager = new SyncManager(db, registry);
      const background = manager.runDue();
      await gate.startedPromise;
      await manager.syncSource(sources[2].id);
      gate.release();
      await background;
      expect(sync.mock.calls.filter(([context]) => context.source.id === sources[2].id)).toHaveLength(1);
    } finally { db.close(); }
  });

});

function replayAdapter(): ConnectorAdapter {
  return {
    manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
    async sync() {
      return {
        entries: [{ url: "https://example.com/post", title: "Dated post", publishedAt: Date.UTC(2024, 1, 4) }],
        metadataRevision: 1,
        iconUrl: "https://example.com/feed-icon.png"
      };
    },
    normalize(item: RawEntry, source: Source): Entry {
      return readerEntry(source, item);
    }
  };
}

function readerEntry(source: Source, item: RawEntry & { createdAt?: number }): Entry {
  const createdAt = item.createdAt ?? Date.now();
  return {
    ...item,
    id: crypto.randomUUID(),
    sourceId: source.id,
    canonicalUrl: item.url,
    contentHash: item.url,
    read: false,
    favorite: false,
    createdAt
  };
}

function deferred() {
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  return { wait, release, started, startedPromise };
}
