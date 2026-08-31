import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncCancelledError, SyncManager } from "../src/main/sync-manager";
import type { ConnectorAdapter, Entry, RawEntry, Source } from "../src/shared/types";

describe("SyncManager", () => {
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
