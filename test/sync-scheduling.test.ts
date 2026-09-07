import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { contentNormalizer } from "../src/main/content-normalizer";
import type { SyncContext, SyncResult } from "../src/shared/types";

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function fixture(urls: string[], operation: (context: SyncContext) => Promise<SyncResult>) {
  const db = new ReadingDatabase(":memory:");
  const sources = urls.map((url, index) => db.createSource({ url, title: `Fixture ${index}`, kind: "rss", pollingEnabled: true }));
  // An explicit deadline order makes this independent of clock resolution.
  vi.spyOn(db, "listDueSources").mockImplementation(() => sources);
  const registry = new ConnectorRegistry();
  registry.register({ manifest: { id: "rss", version: 1, displayName: "Fixture", builtIn: true, capabilities: ["public-http"], allowedHosts: [] },
    sync: operation, normalize: (entry, source) => contentNormalizer.normalize(entry, source) });
  return { db, sources, manager: new SyncManager(db, registry) };
}

const healthy = { entries: [], emptyIsHealthy: true };
const urls = ["https://one.example/a", "https://one.example/b", "https://two.example/a", "https://three.example/a"];

describe("background scheduling across hosts", () => {
  it.each([false, true])("keeps both slots useful without overlapping one host (first fails: %s)", async (fails) => {
    const held = barrier();
    const started: string[] = [];
    const hosts = new Set<string>();
    let peak = 0;
    const { db, sources, manager } = fixture(urls, async ({ source }) => {
      const host = new URL(source.url).hostname;
      expect(hosts.has(host)).toBe(false);
      hosts.add(host); peak = Math.max(peak, hosts.size); started.push(source.url);
      try {
        if (source.url === urls[0]) { await held.wait; if (fails) throw new Error("Synthetic transport failure"); }
        return healthy;
      } finally { hosts.delete(host); }
    });
    const running = manager.runDue();
    try {
      await vi.waitFor(() => expect(started).toContain(urls[3]), { timeout: 200 });
      expect(started).toEqual([urls[0], urls[2], urls[3]]);
      expect(peak).toBe(2);
      held.release(); await running;
      expect(started).toEqual([urls[0], urls[2], urls[3], urls[1]]);
      expect(db.getSource(sources[0].id)?.failureCount).toBe(fails ? 1 : 0);
      expect(db.getSource(sources[1].id)?.failureCount).toBe(0);
      expect(db.listSyncEvents()).toHaveLength(4);
    } finally { held.release(); await running; await manager.close(); db.close(); }
  });

  it("skips a previously due sibling already refreshed manually while its host was busy", async () => {
    const held = barrier();
    const started: string[] = [];
    const { db, sources, manager } = fixture(urls, async ({ source }) => {
      started.push(source.url);
      if (source.url === urls[0]) await held.wait;
      return healthy;
    });
    const manual = manager.syncSource(sources[0].id);
    const sibling = manager.syncSource(sources[1].id);
    const background = manager.runDue();
    try {
      await vi.waitFor(() => expect(started).toContain(urls[3]), { timeout: 200 });
      expect(started).not.toContain(urls[1]);
      held.release(); await Promise.all([manual, sibling, background]);
      expect(started.filter((url) => url === urls[1])).toHaveLength(1);
      expect(db.listSyncEvents()).toHaveLength(4);
    } finally { held.release(); await Promise.allSettled([manual, sibling, background]); await manager.close(); db.close(); }
  });

  it("drains already started work before reporting a scheduler infrastructure failure", async () => {
    const held = barrier();
    const started: string[] = [];
    const { db, sources, manager } = fixture([urls[0], urls[2], urls[3], "https://four.example/a"], async ({ source }) => {
      started.push(source.url);
      if (source.url === urls[2]) await held.wait;
      return healthy;
    });
    const original = db.getSource.bind(db);
    vi.spyOn(db, "getSource").mockImplementation((id) => {
      if (id === sources[2].id) throw new Error("Synthetic database failure");
      return original(id);
    });
    let finished = false;
    const running = manager.runDue().catch((error) => error).finally(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(db.getSource).toHaveBeenCalledWith(sources[2].id));
      expect(finished).toBe(false);
      expect(started).toEqual([urls[0], urls[2]]);
      held.release();
      expect(await running).toMatchObject({ message: "Synthetic database failure" });
      expect(started).toHaveLength(2);
    } finally { held.release(); await running; await manager.close(); db.close(); }
  });

  it("cancels an active batch on shutdown without admitting pending hosts or writing failures", async () => {
    const held = barrier();
    const started: SyncContext[] = [];
    const { db, manager } = fixture(urls, async (context) => {
      started.push(context);
      await held.wait;
      return healthy;
    });
    const running = manager.runDue();
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2));
      let closed = false;
      const closing = manager.close().then(() => { closed = true; });
      expect(started.every((context) => context.signal?.aborted)).toBe(true);
      await Promise.resolve();
      expect(closed).toBe(false);
      held.release();
      await Promise.all([closing, running]);
      expect(started).toHaveLength(2);
      expect(db.listSyncEvents()).toEqual([]);
      expect(db.listSources().every((source) => source.failureCount === 0)).toBe(true);
    } finally { held.release(); await running; await manager.close(); db.close(); }
  });
});
