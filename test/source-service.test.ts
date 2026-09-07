import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("keeps confirmation independent of mutations to the returned preview", async () => {
    const db = new ReadingDatabase(":memory:");
    const service = new SourceService(db, { probe: vi.fn().mockResolvedValue(probeResult({ kind: "manual" })) } as any, { savePreview: vi.fn() } as any, {} as any);
    try {
      const result = await service.preview("https://example.com/feed.xml");
      result.probe.title = "Changed outside the service";
      result.probe.preview.length = 0;
      const saved = await service.confirm(result.token);
      expect(saved.title).toBe("Example Feed");
      await expect(service.confirm(result.token)).rejects.toThrow("预览已过期");
    } finally { db.close(); }
  });

  it("evicts old snapshots by retained size and rejects an unretainable preview", async () => {
    const db = new ReadingDatabase(":memory:");
    const probe = { probe: vi.fn().mockResolvedValue(probeResult({ kind: "manual", message: "x".repeat(1_500_000) })) };
    const service = new SourceService(db, probe as any, { savePreview: vi.fn() } as any, {} as any);
    try {
      const first = await service.preview("https://example.com/feed.xml");
      await service.preview("https://example.com/feed.xml");
      const third = await service.preview("https://example.com/feed.xml");
      await expect(service.confirm(first.token)).rejects.toThrow("预览已过期");
      probe.probe.mockResolvedValueOnce(probeResult({ message: "x".repeat(4_200_000) }));
      await expect(service.preview("https://example.com/feed.xml")).rejects.toThrow("来源预览内容过大");
      expect((await service.confirm(third.token)).title).toBe("Example Feed");
    } finally { db.close(); }
  });

  it("expires confirmation at the exact deadline and bounds pending previews", async () => {
    vi.useFakeTimers();
    const db = new ReadingDatabase(":memory:");
    const sync = { savePreview: vi.fn(), syncSource: vi.fn() };
    const service = new SourceService(db, { probe: vi.fn().mockResolvedValue(probeResult()) } as any, sync as any, {} as any);
    try {
      const first = await service.preview("https://example.com/feed.xml");
      vi.advanceTimersByTime(10 * 60_000);
      await expect(service.confirm(first.token)).rejects.toThrow("预览已过期");
      const oldest = await service.preview("https://example.com/feed.xml");
      for (let i = 0; i < 64; i++) await service.preview("https://example.com/feed.xml");
      await expect(service.confirm(oldest.token)).rejects.toThrow("预览已过期");
      expect(db.listSources()).toEqual([]);
    } finally { db.close(); vi.useRealTimers(); }
  });

  it("recovers the complete confirmed preview after restart when initial networking fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-confirmation-"));
    const path = join(directory, "library.sqlite");
    let db = new ReadingDatabase(path);
    const sync = {
      savePreview: (source: Source, items: RawEntry[]) => db.saveEntries(items.map((item) => entry(source, item))),
      syncSource: vi.fn().mockRejectedValue(new Error("fixture offline"))
    };
    const service = new SourceService(db, { probe: vi.fn().mockResolvedValue(probeResult()) } as any, sync as any, {} as any);
    try {
      const pending = await service.preview("https://example.com/feed.xml");
      const source = await service.confirm(pending.token);
      db.close();
      db = new ReadingDatabase(path);
      expect(db.listSources()).toHaveLength(1);
      expect(db.getSubscriptionForSource(source.id)).toBeDefined();
      expect(db.listEntries(source.id)).toHaveLength(10);
    } finally { db.close(); rmSync(directory, { recursive: true }); }
  });

  it("rolls back a failed preview save and allows the same confirmation to retry", async () => {
    const db = new ReadingDatabase(":memory:");
    const sync = {
      savePreview: vi.fn((source: Source, items: RawEntry[]) => db.saveEntries(items.map((item) => entry(source, item)))),
      syncSource: vi.fn().mockResolvedValue({ inserted: 0 })
    };
    const save = sync.savePreview.getMockImplementation()!;
    sync.savePreview.mockImplementationOnce((source, items) => { save(source, items); throw new Error("fixture disk failure"); });
    const service = new SourceService(db, { probe: vi.fn().mockResolvedValue(probeResult()) } as any, sync as any, {} as any);
    try {
      const pending = await service.preview("https://example.com/feed.xml");
      await expect(service.confirm(pending.token)).rejects.toThrow("fixture disk failure");
      expect(db.listSources()).toEqual([]);
      expect(db.listEntries()).toEqual([]);
      expect(sync.syncSource).not.toHaveBeenCalled();
      const source = await service.confirm(pending.token);
      expect(db.getSubscriptionForSource(source.id)).toBeDefined();
      expect(db.listEntries(source.id)).toHaveLength(10);
      expect(db.listSources()).toHaveLength(1);
    } finally { db.close(); }
  });

  it("notifies library observers only after the source and its preview are both committed", async () => {
    const db = new ReadingDatabase(":memory:");
    const observations: number[] = [];
    const unsubscribe = db.onLibraryChanged(() => { observations.push(db.listEntries().length); });
    const sync = {
      savePreview: (source: Source, items: RawEntry[]) => db.saveEntries(items.map((item) => entry(source, item))),
      syncSource: vi.fn().mockResolvedValue({ inserted: 0 })
    };
    const service = new SourceService(db, { probe: vi.fn().mockResolvedValue(probeResult()) } as any, sync as any, {} as any);
    try {
      const pending = await service.preview("https://example.com/feed.xml");
      await service.confirm(pending.token);
      expect(observations).toEqual([10]);
    } finally { unsubscribe(); db.close(); }
  });

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

  it("stores an archive catalogue descriptor without scheduling history import", async () => {
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

    expect(source.config).toEqual({ archiveCatalog: { url: "https://example.com/archive.html" } });
    expect(db.getSubscriptionForSource(source.id)?.scope).toEqual({ facetSelections: [], history: { mode: "none" } });
    db.close();
  });

  it("inspects an explicit archive catalogue without importing its cards", async () => {
    const db = new ReadingDatabase(":memory:");
    const source = db.createSource({
      url: "https://example.com/feed.xml",
      title: "Example Feed",
      kind: "rss",
      config: { archiveCatalog: { url: "https://example.com/archive.html" } },
      pollingEnabled: true
    });
    const sync = { savePreview: vi.fn(), syncSource: vi.fn() };
    const rss = {
      supportsHistoricalCollection: vi.fn(() => true),
      inspectFacets: vi.fn().mockResolvedValue({
        url: "https://example.com/archive.html",
        totalEntries: 1_864,
        facets: [{ scheme: "feed:https://example.com:category", key: "kubernetes", label: "Kubernetes" }]
      })
    };
    const connectors = { has: vi.fn(() => true), get: vi.fn(() => rss) };
    const service = new SourceService(db, { probe: vi.fn() } as any, sync as any, {} as any, connectors as any);

    expect(service.getCollectionSettings(source.id)).toMatchObject({ facetDiscoveryAvailable: true, historyAvailable: true });
    await expect(service.inspectCollectionFacets(source.id)).resolves.toEqual([
      { sourceId: source.id, entryCount: 0, scheme: "feed:https://example.com:category", key: "kubernetes", label: "Kubernetes" }
    ]);
    expect(rss.inspectFacets).toHaveBeenCalledWith(expect.objectContaining({ id: source.id }), { signal: undefined });
    expect(connectors.get).toHaveBeenCalledWith("rss");
    expect(sync.syncSource).not.toHaveBeenCalled();
    expect(db.listEntries(source.id, 100)).toEqual([]);
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

  it("does not retain a confirmable preview when a cancelled probe returns late", async () => {
    const db = new ReadingDatabase(":memory:");
    const controller = new AbortController();
    let cancel = true;
    const probe = { probe: vi.fn(async (_url: string, signal?: AbortSignal) => {
      if (cancel) { expect(signal).toBe(controller.signal); controller.abort(new Error("cancel preview")); }
      return probeResult();
    }) };
    const service = new SourceService(db, probe as never, {} as never, {} as never);
    const pending = (service as any).pending;
    const retain = vi.spyOn(pending, "set");
    try {
      await expect(service.preview("https://example.com/feed.xml", controller.signal)).rejects.toThrow("cancel preview");
      expect(retain).not.toHaveBeenCalled();
      expect(db.listSources()).toEqual([]);
      cancel = false;
      const retry = await service.preview("https://example.com/feed.xml");
      expect(pending.get(retry.token)).toBeDefined();
      expect(retain).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

});
