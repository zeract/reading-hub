import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import type { CalibrationResult, Entry, Source, SourceKind } from "../src/shared/types";

let db: ReadingDatabase;
let service: SourceService;
let calibrate: ReturnType<typeof vi.fn>;
let cancelSource: ReturnType<typeof vi.fn>;
const rule = { version: 1 as const, itemRootSelector: "article" };
const result: CalibrationResult = { title: "Fixture", url: "https://example.com/", candidates: [{ label: "Fixture cards", confidence: 0.9, rule, preview: [] }] };
function create(kind: SourceKind = "generic"): Source {
  const source = db.createSource({ url: result.url, title: result.title, kind, pollingEnabled: kind !== "manual" });
  db.saveEntries([{ id: "fixture-entry", sourceId: source.id, url: "https://example.com/post", canonicalUrl: "https://example.com/post", title: "Saved card", contentHash: "fixture", read: false, favorite: false, createdAt: 1 } as Entry]);
  return source;
}
beforeEach(() => {
  db = new ReadingDatabase(":memory:");
  calibrate = vi.fn().mockResolvedValue(result); cancelSource = vi.fn();
  service = new SourceService(db, { calibrate } as never, { cancelSource } as never, {} as never);
});
afterEach(() => db.close());

describe("calibration source eligibility", () => {
  it.each(["rss", "manual", "zhihu", "zhihu_follow", "x", "xiaohongshu", "academic"] as const)("rejects rule writes to %s before touching cards or cancelling synchronization", (kind) => {
    const source = create(kind);
    const before = db.getSource(source.id); const entries = db.listEntries();
    expect(() => service.updateRule(source.id, rule)).toThrow("只有普通网页来源需要校准");
    expect(db.getSource(source.id)).toEqual(before); expect(db.listEntries()).toEqual(entries);
    expect(cancelSource).not.toHaveBeenCalled();
  });

  it("rejects detection and confirmation after unsubscribe while retaining existing content", async () => {
    const source = create(); db.setSubscribed(source.id, false);
    const before = db.getSource(source.id); const entries = db.listEntries();
    await expect(service.calibrate(source.id)).rejects.toThrow("重新订阅");
    expect(() => service.updateRule(source.id, rule)).toThrow("重新订阅");
    expect(calibrate).not.toHaveBeenCalled(); expect(cancelSource).not.toHaveBeenCalled();
    expect(db.getSource(source.id)).toEqual(before); expect(db.listEntries()).toEqual(entries);
  });

  it.each(["unsubscribe", "kind"] as const)("rejects a completed detection after %s and permits a fresh retry once eligible", async (change) => {
    const source = create();
    let resolve!: (value: CalibrationResult) => void;
    calibrate.mockReturnValueOnce(new Promise<CalibrationResult>((done) => { resolve = done; }));
    const pending = service.calibrate(source.id);
    const rejected = expect(pending).rejects.toThrow(change === "kind" ? "只有普通网页" : "重新订阅");
    if (change === "kind") db.updateSourceSettings(source.id, { title: source.title, kind: "rss", pollingEnabled: true });
    else db.setSubscribed(source.id, false);
    const before = db.getSource(source.id); const entries = db.listEntries();
    resolve(result); await rejected;
    expect(db.getSource(source.id)).toEqual(before); expect(db.listEntries()).toEqual(entries);
    if (change === "kind") db.updateSourceSettings(source.id, { title: source.title, kind: "generic", pollingEnabled: true });
    else db.setSubscribed(source.id, true);
    await expect(service.calibrate(source.id)).resolves.toEqual(result);
  });

  it("allows presentation and polling preference changes during read-only detection", async () => {
    const source = create();
    let resolve!: (value: CalibrationResult) => void;
    calibrate.mockReturnValueOnce(new Promise<CalibrationResult>((done) => { resolve = done; }));
    const pending = service.calibrate(source.id);
    db.updateSourceSettings(source.id, { title: "Renamed", category: "Folder", kind: "generic", pollingEnabled: false });
    resolve(result); await expect(pending).resolves.toEqual(result);
    expect(db.getSource(source.id)).toMatchObject({ title: "Renamed", category: "Folder", pollingEnabled: false });
    expect(db.listEntries()).toHaveLength(1); expect(cancelSource).not.toHaveBeenCalled();
  });

  it("preserves explicit cancellation over a late eligibility failure", async () => {
    const source = create(); const controller = new AbortController();
    calibrate.mockImplementationOnce(async () => {
      db.setSubscribed(source.id, false); controller.abort(new Error("Synthetic cancellation")); return result;
    });
    await expect(service.calibrate(source.id, controller.signal)).rejects.toThrow("Synthetic cancellation");
    expect(db.listEntries()).toHaveLength(1); expect(cancelSource).not.toHaveBeenCalled();
  });
});
