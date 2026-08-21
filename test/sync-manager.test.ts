import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager } from "../src/main/sync-manager";
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
