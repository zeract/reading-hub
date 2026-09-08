import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import type { Entry, Facet, FacetCatalog, Source } from "../src/shared/types";

const alpha = { scheme: "fixture", key: "alpha", label: "Alpha" };
const beta = { scheme: "fixture", key: "beta", label: "Beta" };
const archiveUrl = "https://example.com/archive";
let directory: string;
let db: ReadingDatabase;
let writer: Sqlite.Database;
let source: Source;
let service: SourceService;
let inspect: ReturnType<typeof vi.fn>;
let hasAdapter: ReturnType<typeof vi.fn>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function save(id: string, facets: Facet[]) {
  db.saveEntries([{ id, sourceId: source.id, url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`, title: id, contentHash: id, read: false, favorite: false, createdAt: 1, facets } as Entry]);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "facet-discovery-lifetime-"));
  const path = join(directory, "fixture.sqlite");
  db = new ReadingDatabase(path); writer = new Sqlite(path);
  source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true, config: { mode: "fixture", archiveCatalog: { url: archiveUrl } } });
  inspect = vi.fn().mockResolvedValue({ facets: [] }); hasAdapter = vi.fn(() => true);
  const adapter = { inspectFacets: inspect };
  service = new SourceService(db, {} as never, {} as never, {} as never, { has: hasAdapter, get: () => adapter } as never);
});
afterEach(() => { writer.close(); db.close(); rmSync(directory, { recursive: true }); });

describe("source facet discovery snapshot", () => {
  it("merges the remote labels with counts and categories collected while discovery was pending", async () => {
    save("first", [alpha]); const read = deferred<FacetCatalog>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id);
    save("second", [alpha, beta]);
    const revision = db.getLibraryRevision(); const entries = db.listEntries();
    read.resolve({ facets: [{ ...alpha, label: "Publisher alpha" }, { scheme: "fixture", key: "remote", label: "Remote" }] });
    await expect(pending).resolves.toEqual([
      { ...alpha, label: "Publisher alpha", sourceId: source.id, entryCount: 2 },
      { ...beta, sourceId: source.id, entryCount: 1 },
      { scheme: "fixture", key: "remote", label: "Remote", sourceId: source.id, entryCount: 0 }
    ]);
    expect(db.getLibraryRevision()).toBe(revision); expect(db.listEntries()).toEqual(entries);
  });

  it.each([undefined, { facets: [] }])("uses current local facets when the remote catalog is %j", async (catalog) => {
    save("first", [alpha]); const read = deferred<FacetCatalog | undefined>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id);
    save("first", []); save("second", [beta]); read.resolve(catalog);
    await expect(pending).resolves.toEqual([{ ...beta, sourceId: source.id, entryCount: 1 }]);
  });

  it.each([false, true])("rejects an obsolete connector result after a source type change (remote failure: %s)", async (failed) => {
    const read = deferred<FacetCatalog>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id);
    const rejected = expect(pending).rejects.toThrow("来源配置已更新");
    db.updateSourceSettings(source.id, { title: source.title, kind: "generic", pollingEnabled: true });
    if (failed) read.reject(new Error("Old endpoint failure")); else read.resolve({ facets: [alpha] });
    await rejected; expect(db.listEntries()).toEqual([]);
  });

  it("rejects a changed archive configuration even if the adapter and source type are unchanged", async () => {
    const read = deferred<FacetCatalog>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id);
    const rejected = expect(pending).rejects.toThrow("来源配置已更新");
    writer.prepare("UPDATE subscriptions SET config_json = ? WHERE source_id = ?").run(JSON.stringify({ mode: "fixture", archiveCatalog: { url: "https://example.com/new-archive" } }), source.id);
    read.resolve({ facets: [alpha] }); await rejected;
    inspect.mockResolvedValueOnce({ facets: [beta] });
    await expect(service.inspectCollectionFacets(source.id)).resolves.toEqual([{ ...beta, sourceId: source.id, entryCount: 0 }]);
  });

  it("preserves valid discovery across renamed folders, polling, scopes and reordered configuration keys", async () => {
    const read = deferred<FacetCatalog>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id);
    db.updateSourceSettings(source.id, { title: "Renamed", category: "Folder", kind: "rss", pollingEnabled: false });
    db.updateSubscriptionScope(source.id, { facetSelections: [alpha], history: { mode: "none" } });
    writer.prepare("UPDATE subscriptions SET config_json = ? WHERE source_id = ?").run(JSON.stringify({ archiveCatalog: { url: archiveUrl }, mode: "fixture" }), source.id);
    read.resolve({ facets: [alpha] });
    await expect(pending).resolves.toEqual([{ ...alpha, sourceId: source.id, entryCount: 0 }]);
    expect(db.getSource(source.id)).toMatchObject({ title: "Renamed", category: "Folder", pollingEnabled: false });
    expect(db.getSubscriptionForSource(source.id)?.scope.facetSelections).toEqual([alpha]);
  });

  it("does not return facets for a source that was deleted during discovery", async () => {
    const read = deferred<FacetCatalog>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id); const rejected = expect(pending).rejects.toThrow("来源不存在");
    db.deleteSource(source.id); read.resolve({ facets: [alpha] }); await rejected;
  });

  it("preserves cancellation over obsolete results and does not begin a pre-cancelled discovery", async () => {
    const controller = new AbortController(); const read = deferred<FacetCatalog>(); inspect.mockReturnValueOnce(read.promise);
    const pending = service.inspectCollectionFacets(source.id, controller.signal); const rejected = expect(pending).rejects.toThrow("Synthetic cancellation");
    db.updateSourceSettings(source.id, { title: source.title, kind: "generic", pollingEnabled: true });
    controller.abort(new Error("Synthetic cancellation")); read.resolve({ facets: [alpha] }); await rejected;
    await expect(service.inspectCollectionFacets(source.id, controller.signal)).rejects.toThrow("Synthetic cancellation");
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("keeps ordinary remote failures retryable without changing library or scope", async () => {
    save("first", [alpha]); const revision = db.getLibraryRevision(); const scope = db.getSubscriptionForSource(source.id)?.scope;
    inspect.mockRejectedValueOnce(new Error("Synthetic archive unavailable"));
    await expect(service.inspectCollectionFacets(source.id)).rejects.toThrow("Synthetic archive unavailable");
    await expect(service.inspectCollectionFacets(source.id)).resolves.toEqual([{ ...alpha, sourceId: source.id, entryCount: 1 }]);
    expect(db.getLibraryRevision()).toBe(revision); expect(db.getSubscriptionForSource(source.id)?.scope).toEqual(scope);
  });

  it("returns only local metadata when the source has no discovery adapter", async () => {
    save("first", [alpha]); hasAdapter.mockReturnValue(false); db.setSubscribed(source.id, false);
    await expect(service.inspectCollectionFacets(source.id)).resolves.toEqual([{ ...alpha, sourceId: source.id, entryCount: 1 }]);
    expect(inspect).not.toHaveBeenCalled();
  });
});
