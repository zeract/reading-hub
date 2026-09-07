import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import { SyncManager } from "../src/main/sync-manager";
import { ConnectorRegistry } from "../src/main/connector-registry";
import type { Source } from "../src/shared/types";

const serviceFor = (db: ReadingDatabase, sync: Pick<SyncManager, "cancelSource"> = { cancelSource: vi.fn() }) => new SourceService(db, undefined as never, sync as never, undefined as never);
const rename = (service: SourceService, source: Source) => service.updateSettings(source.id, {
  title: "Renamed fixture", category: "Research", kind: source.kind,
  pollingEnabled: source.pollingEnabled, refreshIntervalMinutes: source.refreshIntervalMinutes
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["due", "scheduled", "error", "review", "paused"])("preserves the %s schedule when only display metadata changes", (state) => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const db = new ReadingDatabase(":memory:");
  try {
    let source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: state === "review" ? "generic" : "rss", pollingEnabled: true, refreshIntervalMinutes: 60 });
    if (state === "scheduled") source = db.markSuccess(source, {});
    if (state === "error") source = db.markFailure(source, "Fixture offline");
    if (state === "review") source = db.markSuccess(source, { requiresReview: true });
    if (state === "paused") source = db.pauseSource(source.id, "Fixture pause");
    db.saveCheckpoint(source.id, { cursor: "fixture-cursor" });
    const checkpoint = db.getCheckpoint(source.id);
    const expectedDue = db.listDueSources().map((item) => item.id);
    const sync = { cancelSource: vi.fn() };
    const random = vi.spyOn(Math, "random");
    vi.setSystemTime(Date.now() + 1_000);
    const service = serviceFor(db, sync);
    const updated = rename(service, source);
    expect(updated).toMatchObject({ title: "Renamed fixture", category: "Research", status: source.status, failureCount: source.failureCount });
    expect(updated.nextCheckAt).toBe(source.nextCheckAt);
    expect(updated.lastError).toBe(source.lastError);
    expect(db.getCheckpoint(source.id)).toEqual(checkpoint);
    expect(db.listDueSources().map((item) => item.id)).toEqual(expectedDue);
    expect(rename(service, updated).nextCheckAt).toBe(source.nextCheckAt);
    expect(random).not.toHaveBeenCalled();
    expect(sync.cancelSource).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it("still admits an already-due source after its title changes", async () => {
  const db = new ReadingDatabase(":memory:");
  const registry = new ConnectorRegistry();
  const connectorSync = vi.fn(async (_context: { source: Source }) => ({ entries: [], emptyIsHealthy: true }));
  registry.register({ manifest: { id: "rss", version: 1, displayName: "Fixture", builtIn: true, capabilities: ["public-http"], allowedHosts: [] }, sync: connectorSync, normalize: () => { throw new Error("No entries expected"); } });
  const manager = new SyncManager(db, registry);
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
    rename(serviceFor(db, manager), source);
    await manager.runDue();
    expect(connectorSync).toHaveBeenCalledTimes(1);
    expect(connectorSync.mock.calls[0]?.[0]).toMatchObject({ source: { title: "Renamed fixture", category: "Research" } });
    expect(db.getSource(source.id)?.nextCheckAt).toBeGreaterThan(Date.now());
  } finally { await manager.close(); db.close(); }
});

it("reschedules actual cadence changes and cancels work when polling is toggled", () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const db = new ReadingDatabase(":memory:");
  const sync = { cancelSource: vi.fn() };
  const service = serviceFor(db, sync);
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true, refreshIntervalMinutes: 60 });
    const settings = { title: source.title, kind: source.kind, pollingEnabled: true, refreshIntervalMinutes: 120 };
    const changed = service.updateSettings(source.id, settings);
    expect(changed.nextCheckAt).toBe(Date.now() + 120 * 60_000);
    expect(sync.cancelSource).not.toHaveBeenCalled();

    const disabled = service.updateSettings(source.id, { ...settings, pollingEnabled: false });
    expect(disabled.nextCheckAt).toBeUndefined();
    expect(db.listDueSources(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(sync.cancelSource).toHaveBeenCalledExactlyOnceWith(source.id);

    const enabled = service.updateSettings(source.id, settings);
    expect(enabled.nextCheckAt).toBe(Date.now() + 120 * 60_000);
    expect(db.listDueSources(enabled.nextCheckAt!).map((item) => item.id)).toEqual([source.id]);
    expect(sync.cancelSource).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});

it("retains metadata edits and the original retry deadline after reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "reading-hub-settings-schedule-"));
  const path = join(directory, "fixture.sqlite");
  let db = new ReadingDatabase(path);
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true, refreshIntervalMinutes: 1440 });
    const failed = db.markFailure(source, "Fixture offline");
    rename(serviceFor(db), failed);
    db.close(); db = new ReadingDatabase(path);
    expect(db.getSource(source.id)).toMatchObject({ title: "Renamed fixture", category: "Research", nextCheckAt: failed.nextCheckAt, status: "error", failureCount: 1, lastError: "Fixture offline" });
    expect(db.listDueSources(failed.nextCheckAt! - 1)).toEqual([]);
    expect(db.listDueSources(failed.nextCheckAt!).map((item) => item.id)).toEqual([source.id]);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
