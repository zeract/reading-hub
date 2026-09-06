import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncCancelledError, SyncManager } from "../src/main/sync-manager";
import { ZhihuConnector } from "../src/main/zhihu";
import type { Followee, RawEntry } from "../src/shared/types";

const { fetchZhihu } = vi.hoisted(() => ({ fetchZhihu: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: fetchZhihu }));

const own: RawEntry = { url: "https://zhuanlan.zhihu.com/p/1", title: "Own" };
const collected: RawEntry = { url: "https://zhuanlan.zhihu.com/p/2", title: "Collected" };
const followee: Followee = { urlToken: "example", fullname: "Example", url: "https://www.zhihu.com/people/example", updatedAt: 1 };

function harness() {
  const db = new ReadingDatabase(":memory:");
  const source = db.createSource({ url: "https://developer.zhihu.com/api/v1/user/contents", title: "Zhihu", kind: "zhihu", pollingEnabled: true });
  const connector = new ZhihuConnector(async () => null);
  vi.spyOn(connector, "fetchEntries").mockResolvedValue([own]);
  vi.spyOn(connector, "fetchRecentCollections").mockResolvedValue([collected]);
  vi.spyOn(connector, "fetchFollowees").mockResolvedValue([followee]);
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const manager = new SyncManager(db, registry);
  return { db, source, connector, manager };
}

describe("Zhihu host-owned sync", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("saves collections and followees before resolving, counts all cards and deduplicates replay", async () => {
    const { db, source, manager } = harness();
    try {
      const saveFollowees = vi.spyOn(db, "upsertFollowees");
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 2 });
      expect(db.listEntries(source.id).map((entry) => entry.title).sort()).toEqual(["Collected", "Own"]);
      expect(db.listSyncEvents(source.id)[0]).toMatchObject({ fetchedCount: 2, insertedCount: 2 });
      expect(saveFollowees).toHaveBeenCalledWith([followee]);
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 0 });
    } finally { db.close(); }
  });

  it("applies collection scope equally to own content and supplemental collections", async () => {
    const { db, source, connector, manager } = harness();
    try {
      const selected = { scheme: "provider:test", key: "selected", label: "Selected" };
      db.updateSubscriptionScope(source.id, { facetSelections: [selected], history: { mode: "none" } });
      vi.mocked(connector.fetchEntries).mockResolvedValue([{ ...own, facets: [selected] }]);
      vi.mocked(connector.fetchRecentCollections).mockResolvedValue([{ ...collected, facets: [] }]);
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 1 });
      expect(db.listEntries(source.id).map((entry) => entry.title)).toEqual(["Own"]);
    } finally { db.close(); }
  });

  it("retains successful own content when optional endpoints fail", async () => {
    const { db, source, connector, manager } = harness();
    try {
      vi.mocked(connector.fetchRecentCollections).mockRejectedValue(new Error("collections unavailable"));
      vi.mocked(connector.fetchFollowees).mockRejectedValue(new Error("followees unavailable"));
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 1, source: { status: "active" } });
    } finally { db.close(); }
  });

  it.each(["delete", "pause", "scope"] as const)("rejects all supplemental writes after %s during their fetch", async (change) => {
    const { db, source, connector, manager } = harness();
    try {
      let release!: (entries: RawEntry[]) => void;
      vi.mocked(connector.fetchRecentCollections).mockReturnValue(new Promise((resolve) => { release = resolve; }));
      const saveFollowees = vi.spyOn(db, "upsertFollowees");
      const refreshing = manager.syncSource(source.id);
      await vi.waitFor(() => expect(connector.fetchRecentCollections).toHaveBeenCalled());
      if (change === "delete") db.deleteSource(source.id);
      if (change === "pause") db.pauseSource(source.id, "User paused");
      if (change === "scope") db.updateSubscriptionScope(source.id, { facetSelections: [], history: { mode: "all" } });
      release([collected]);
      await expect(refreshing).rejects.toBeInstanceOf(SyncCancelledError);
      expect(db.listEntries()).toEqual([]);
      expect(db.listSyncEvents()).toEqual([]);
      expect(saveFollowees).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("never exposes a provider error body that echoes authorization material", async () => {
    vi.useFakeTimers();
    fetchZhihu.mockImplementation(async () => new Response(JSON.stringify({ Message: "echo fixture-access-secret" }), { status: 401 }));
    const connector = new ZhihuConnector(async () => "fixture-access-secret");
    const result = expect(connector.fetchEntries()).rejects.toThrow("知乎授权无效或权限不足");
    await vi.runAllTimersAsync();
    await result;
  });
});
