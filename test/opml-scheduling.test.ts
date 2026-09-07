import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadingDatabase } from "../src/main/database";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { contentNormalizer } from "../src/main/content-normalizer";
import { SourceService } from "../src/main/source-service";
import { SyncManager } from "../src/main/sync-manager";
import type { SyncContext, SyncResult } from "../src/shared/types";

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const opml = (hosts: string[]) => `<opml><body>${hosts.map((host) => `<outline text="${host}" xmlUrl="https://${host}.example/feed"/>`).join("")}</body></opml>`;
const healthy = { entries: [], emptyIsHealthy: true };

function fixture(operation: (context: SyncContext) => Promise<SyncResult>, path = ":memory:") {
  const db = new ReadingDatabase(path);
  const registry = new ConnectorRegistry();
  registry.register({ manifest: { id: "rss", version: 1, displayName: "Fixture", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
    sync: operation, normalize: (entry, source) => contentNormalizer.normalize(entry, source) });
  const sync = new SyncManager(db, registry);
  return { db, sync, service: new SourceService(db, {} as never, sync, {} as never) };
}

describe("OPML imports share the background scheduler", () => {
  it.each([false, true])("does not repeat a source completed by a scheduler tick (failed: %s)", async (fails) => {
    const held = barrier();
    const calls: string[] = [];
    const { db, sync, service } = fixture(async ({ source }) => {
      calls.push(source.title);
      if (source.title === "one") await held.wait;
      if (source.title === "two" && fails) throw new Error("Synthetic unavailable source");
      return healthy;
    });
    try {
      service.importOpml(opml(["one", "two"]));
      await vi.waitFor(() => expect(calls).toContain("one"));
      sync.start();
      await vi.waitFor(() => expect(db.listSyncEvents()).toHaveLength(1));
      held.release();
      await vi.waitFor(() => expect(db.listSyncEvents().length).toBeGreaterThanOrEqual(2));
      await tick();
      expect(calls).toEqual(["one", "two"]);
      const second = db.listSources().find((source) => source.title === "two")!;
      expect(second.failureCount).toBe(fails ? 1 : 0);
      expect(second.nextCheckAt).toBeGreaterThan(Date.now());
    } finally { held.release(); await sync.close(); db.close(); }
  });

  it("queues imports arriving during an active pass without exceeding the shared concurrency limit", async () => {
    const held = barrier();
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const { db, sync, service } = fixture(async ({ source }) => {
      active++; peak = Math.max(peak, active); calls.push(source.title);
      try { if (source.title !== "three") await held.wait; return healthy; }
      finally { active--; }
    });
    try {
      // Separate imports previously created separate, untracked worker loops.
      service.importOpml(opml(["one"]));
      service.importOpml(opml(["two"]));
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      service.importOpml(opml(["three"]));
      await tick();
      expect(calls).toEqual(["one", "two"]);
      held.release();
      await vi.waitFor(() => expect(calls).toContain("three"));
      expect(peak).toBe(2);
      expect(calls).toHaveLength(3);
      expect(service.importOpml(opml(["three"]))).toEqual({ imported: 0, existing: 1, skipped: 0 });
      await tick();
      expect(calls).toHaveLength(3);
    } finally { held.release(); await sync.close(); db.close(); }
  });

  it("coalesces repeated wakes into one fresh pass after active work drains", async () => {
    const held = barrier();
    const { db, sync } = fixture(async () => healthy);
    const run = vi.spyOn(sync, "runDue").mockImplementationOnce(async () => held.wait).mockResolvedValue(undefined);
    try {
      sync.requestDueRun();
      await tick();
      for (let i = 0; i < 20; i++) sync.requestDueRun();
      await tick();
      expect(run).toHaveBeenCalledTimes(1);
      held.release(); await tick();
      expect(run).toHaveBeenCalledTimes(2);
      await tick();
      expect(run).toHaveBeenCalledTimes(2);
      sync.requestDueRun(); await tick();
      expect(run).toHaveBeenCalledTimes(3);
    } finally { held.release(); await sync.close(); db.close(); }
  });

  it.each([false, true])("recovers from infrastructure failure without spinning (wake during reporting: %s)", async (wakeDuringReporting) => {
    const { db, sync } = fixture(async () => healthy);
    const list = vi.spyOn(db, "listDueSources").mockImplementationOnce(() => { throw new Error("Synthetic scheduler failure"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { if (wakeDuringReporting) sync.requestDueRun(); });
    try {
      sync.requestDueRun(); await tick(); await tick();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(wakeDuringReporting ? 2 : 1);
      if (!wakeDuringReporting) { sync.requestDueRun(); await tick(); }
      expect(list).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { await sync.close(); db.close(); warn.mockRestore(); }
  });

  it("drains shutdown and resumes committed imports from SQLite after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opml-scheduler-restart-"));
    const path = join(directory, "fixture.sqlite");
    const held = barrier();
    const calls: SyncContext[] = [];
    let current = fixture(async (context) => { calls.push(context); await held.wait; return healthy; }, path);
    try {
      current.service.importOpml(opml(["one", "two"]));
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      current.service.importOpml(opml(["three"]));
      const closing = current.sync.close();
      current.sync.requestDueRun();
      expect(calls.every((context) => context.signal?.aborted)).toBe(true);
      held.release(); await closing;
      expect(calls).toHaveLength(2);
      expect(current.db.listSyncEvents()).toEqual([]);
      current.db.close();
      const resumed: string[] = [];
      current = fixture(async ({ source }) => { resumed.push(source.title); return healthy; }, path);
      current.sync.requestDueRun();
      await vi.waitFor(() => expect(current.db.listSyncEvents()).toHaveLength(3));
      expect(resumed.sort()).toEqual(["one", "three", "two"]);
      expect(current.db.listSources()).toHaveLength(3);
    } finally { held.release(); await current.sync.close(); current.db.close(); rmSync(directory, { recursive: true }); }
  });
});
