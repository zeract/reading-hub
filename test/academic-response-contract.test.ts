import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcademicAuthorConnector } from "../src/main/academic";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager } from "../src/main/sync-manager";

const providers = [
  { name: "OpenAlex", config: { openAlexId: "A1" }, field: "results" },
  { name: "Semantic Scholar", config: { semanticScholarId: "1" }, field: "data" },
  { name: "ORCID", config: { orcid: "0000-0002-1825-0097" }, field: "group" }
];
const json = (value: unknown) => new Response(JSON.stringify(value));
function setup(config: Record<string, unknown>, fetcher: (url: string) => Promise<Response>, path = ":memory:") {
  const database = new ReadingDatabase(path);
  const source = database.listSources()[0] ?? database.createSource({ url: "https://example.com/author", title: "Fixture", kind: "academic", config: { authorName: "Fixture", ...config }, pollingEnabled: true });
  const subscription = database.getSubscriptionForSource(source.id)!;
  const connector = new AcademicAuthorConnector(fetcher);
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const manager = new SyncManager(database, registry);
  return { database, source, subscription, connector, manager, close: async () => { await manager.close(); database.close(); } };
}

describe("academic response contract", () => {
  for (const provider of providers) {
    it.each([{}, null, [], { error: "fixture-private-details" }, { [provider.field]: null }, { [provider.field]: {} }, { [provider.field]: [null] }, { [provider.field]: ["fixture-private-details"] }])(`rejects malformed ${provider.name} collections: %j`, async (payload) => {
      const run = setup(provider.config, async () => json(payload));
      try {
        await expect(run.connector.sync(run)).rejects.toThrow(`${provider.name} 论文响应无效`);
      } finally { await run.close(); }
    });

    it(`accepts an explicit empty ${provider.name} collection`, async () => {
      const run = setup(provider.config, async () => json({ [provider.field]: [] }));
      try { expect(await run.connector.sync(run)).toMatchObject({ entries: [], emptyIsHealthy: true }); }
      finally { await run.close(); }
    });
  }

  it("does not commit success when one provider is empty and another failed", async () => {
    const run = setup({ openAlexId: "A1", semanticScholarId: "1" }, async (url) => url.includes("openalex.org") ? json({ results: [] }) : new Response("{}", { status: 503 }));
    run.database.saveCheckpoint(run.subscription.id, { data: { retained: true } });
    const before = run.database.getCheckpoint(run.subscription.id);
    try {
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow("503");
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(before);
      expect(run.database.getSource(run.source.id)).toMatchObject({ status: "error", failureCount: 1 });
      expect(run.database.getSource(run.source.id)?.lastSuccessfulAt).toBeUndefined();
      expect(run.database.listEntries()).toEqual([]);
    } finally { await run.close(); }
  });

  it("keeps useful records from a healthy provider during a partial outage", async () => {
    const run = setup({ openAlexId: "A1", semanticScholarId: "1" }, async (url) => url.includes("openalex.org")
      ? json({ results: [{ id: "https://openalex.org/W1", title: "Fixture paper" }] }) : json({ error: "fixture-private-details" }));
    try {
      expect(await run.connector.sync(run)).toMatchObject({ entries: [{ title: "Fixture paper", providerLabel: "OpenAlex" }] });
    } finally { await run.close(); }
  });

  it("retains state across a malformed collection, restart and successful retry without duplicates", async () => {
    const folder = mkdtempSync(join(tmpdir(), "reading-hub-academic-contract-"));
    const path = join(folder, "fixture.sqlite");
    const old = { id: "https://openalex.org/W1", title: "Old paper", publication_date: "2025-01-01" };
    const recent = { id: "https://openalex.org/W2", title: "Recent paper", publication_date: "2026-01-01" };
    let payload: unknown = { results: [old] };
    const fetcher = async () => json(payload);
    let run = setup({ openAlexId: "A1" }, fetcher, path);
    try {
      await run.manager.syncSource(run.source.id);
      const checkpoint = run.database.getCheckpoint(run.subscription.id);
      const successfulAt = run.database.getSource(run.source.id)?.lastSuccessfulAt;
      payload = { results: [recent, "fixture-private-details"] };
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow("OpenAlex 论文响应无效");
      const failed = run.database.getSource(run.source.id)!;
      expect(failed).toMatchObject({ status: "error", failureCount: 1, lastSuccessfulAt: successfulAt });
      expect(failed.nextCheckAt).toBeGreaterThan(failed.lastCheckedAt!);
      expect(failed.lastError).not.toContain("fixture-private-details");
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(run.database.listEntries()).toHaveLength(1);
      await run.close();
      run = setup({ openAlexId: "A1" }, fetcher, path);
      expect(run.database.getSource(run.source.id)).toMatchObject({ status: "error", failureCount: 1, lastSuccessfulAt: successfulAt });
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      payload = { results: [old, recent] };
      await run.manager.syncSource(run.source.id);
      await run.manager.syncSource(run.source.id);
      expect(run.database.listEntries().map((entry) => entry.title)).toEqual(["Recent paper", "Old paper"]);
      expect(run.database.getSource(run.source.id)).toMatchObject({ status: "active", failureCount: 0 });
      expect(run.database.getSource(run.source.id)?.lastError).toBeUndefined();
    } finally { await run.close(); rmSync(folder, { recursive: true, force: true }); }
  });

});
