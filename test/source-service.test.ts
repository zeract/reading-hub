import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import type { Entry, ProbeResult, RawEntry, Source } from "../src/shared/types";

function rawEntries(count: number): RawEntry[] {
  return Array.from({ length: count }, (_item, index) => ({
    url: `https://example.com/posts/${index + 1}`,
    title: `Post ${index + 1}`,
    publishedAt: Date.UTC(2026, 7, 1, 0, 0, index)
  }));
}

function entry(source: Source, raw: RawEntry): Entry {
  return {
    id: crypto.randomUUID(),
    sourceId: source.id,
    canonicalUrl: raw.url,
    url: raw.url,
    title: raw.title,
    publishedAt: raw.publishedAt,
    contentHash: raw.url,
    read: false,
    favorite: false,
    createdAt: Date.now(),
    providerId: source.connectorId
  };
}

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    kind: "rss",
    title: "Example Feed",
    url: "https://example.com/feed.xml",
    confidence: 1,
    preview: rawEntries(10),
    requiresReview: false,
    ...overrides
  };
}

describe("SourceService initial acquisition", () => {
  it("persists the capped preview then immediately performs a full initial sync", async () => {
    const db = new ReadingDatabase(":memory:");
    const full = rawEntries(24);
    const sync = {
      savePreview: vi.fn((source: Source, items: RawEntry[]) => db.saveEntries(items.map((item) => entry(source, item)))),
      syncSource: vi.fn(async (sourceId: string) => {
        const source = db.getSource(sourceId)!;
        db.saveEntries(full.map((item) => entry(source, item)));
        return { inserted: 14, source };
      })
    };
    const service = new SourceService(
      db,
      { probe: vi.fn().mockResolvedValue(probeResult()) } as any,
      sync as any,
      {} as any
    );

    const pending = await service.preview("https://example.com/feed.xml");
    const source = await service.confirm(pending.token);

    expect(sync.savePreview).toHaveBeenCalledWith(expect.objectContaining({ id: source.id }), expect.any(Array));
    expect(sync.syncSource).toHaveBeenCalledWith(source.id);
    expect(db.listEntries(source.id, 100)).toHaveLength(24);
    db.close();
  });

  it("stores a verified archive backfill descriptor without storing archive content", async () => {
    const db = new ReadingDatabase(":memory:");
    const sync = { savePreview: vi.fn(), syncSource: vi.fn().mockResolvedValue({ inserted: 0 }) };
    const service = new SourceService(
      db,
      { probe: vi.fn().mockResolvedValue(probeResult({ historicalArchiveUrl: "https://example.com/archive.html" })) } as any,
      sync as any,
      {} as any
    );

    const pending = await service.preview("https://example.com/feed.xml");
    const source = await service.confirm(pending.token);

    expect(source.config).toEqual({ archiveBackfill: { url: "https://example.com/archive.html" } });
    db.close();
  });

  it("keeps a saved preview when the initial network sync fails", async () => {
    const db = new ReadingDatabase(":memory:");
    const sync = {
      savePreview: vi.fn((source: Source, items: RawEntry[]) => db.saveEntries(items.map((item) => entry(source, item)))),
      syncSource: vi.fn().mockRejectedValue(new Error("temporary network failure"))
    };
    const service = new SourceService(
      db,
      { probe: vi.fn().mockResolvedValue(probeResult()) } as any,
      sync as any,
      {} as any
    );

    const pending = await service.preview("https://example.com/feed.xml");
    const source = await service.confirm(pending.token);

    expect(source.status).toBe("active");
    expect(sync.syncSource).toHaveBeenCalledWith(source.id);
    expect(db.listEntries(source.id, 100)).toHaveLength(10);
    db.close();
  });

  it("does not auto-sync a low-confidence page before its extraction rule is reviewed", async () => {
    const db = new ReadingDatabase(":memory:");
    const sync = { savePreview: vi.fn(), syncSource: vi.fn() };
    const service = new SourceService(
      db,
      { probe: vi.fn().mockResolvedValue(probeResult({ kind: "generic", confidence: 0.4, requiresReview: true })) } as any,
      sync as any,
      {} as any
    );

    const pending = await service.preview("https://example.com/");
    const source = await service.confirm(pending.token);

    expect(source.status).toBe("needs_review");
    expect(sync.syncSource).not.toHaveBeenCalled();
    db.close();
  });
});
