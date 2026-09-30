import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { contentNormalizer } from "../src/main/content-normalizer";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager } from "../src/main/sync-manager";
import type { RawEntry } from "../src/shared/types";

describe("declared content identity during sync", () => {
  it("skips one conflicting item, commits an unrelated item, and records only a bounded warning", async () => {
    const db = new ReadingDatabase(":memory:");
    const registry = new ConnectorRegistry();
    registry.register({
      manifest: { id: "academic", version: 1, displayName: "Fixture", builtIn: true, identityNamespaces: ["doi"] },
      async sync() {
        return { entries: [
          { url: "https://publisher.example/conflict", title: "Wrong identity", canonicalIdentity: "doi:10.1000/two" },
          { url: "https://publisher.example/safe", title: "Safe paper", canonicalIdentity: "doi:10.1000/safe" }
        ] satisfies RawEntry[] };
      },
      normalize: (item, source) => contentNormalizer.normalize(item, source)
    });
    const manager = new SyncManager(db, registry);
    try {
      const first = db.createSource({ url: "https://example.com/author-a", title: "First", kind: "academic", pollingEnabled: true });
      const second = db.createSource({ url: "https://example.com/author-b", title: "Second", kind: "academic", pollingEnabled: true });
      const existing = contentNormalizer.normalize({
        url: "https://publisher.example/conflict", title: "Correct paper", canonicalIdentity: "doi:10.1000/one"
      }, first);
      db.saveEntries([existing], { identityNamespaces: ["doi"] });
      const result = await manager.syncSource(second.id);
      expect(result.inserted).toBe(1);
      expect(db.getEntry(existing.id)).toMatchObject({ title: "Correct paper", canonicalIdentity: "doi:10.1000/one" });
      expect(db.getEntry(existing.id)?.origins).toHaveLength(1);
      expect(db.listEntries(second.id).map((entry) => entry.title)).toEqual(["Safe paper"]);
      const warning = db.listSyncEvents(second.id)[0];
      expect(warning).toMatchObject({ outcome: "warning", fetchedCount: 2, insertedCount: 1 });
      expect(warning.message).toContain("已跳过 1 条身份冲突内容");
      expect(warning.message).not.toMatch(/10\.1000|publisher\.example/);
    } finally { await manager.close(); db.close(); }
  });
});
