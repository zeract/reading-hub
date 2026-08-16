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
    expect(result.inserted).toBe(0);
    expect(db.listEntries(source.id)).toEqual([expect.objectContaining({ publishedAt: Date.UTC(2024, 1, 4) })]);
    db.close();
  });
});

function replayAdapter(): ConnectorAdapter {
  return {
    manifest: { id: "rss", version: 1, displayName: "RSS", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
    async sync() {
      return {
        entries: [{ url: "https://example.com/post", title: "Dated post", publishedAt: Date.UTC(2024, 1, 4) }],
        metadataRevision: 1
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
