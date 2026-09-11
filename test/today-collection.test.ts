import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { GenericConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { entryQueryForLibrary } from "../src/renderer/library-view";
import type { RawEntry } from "../src/shared/types";

it("keeps initial imports distinct across preview, failed retry, restart, repeat sync and shared origins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reading-hub-today-"));
  const file = join(directory, "library.sqlite");
  const now = new Date(2026, 8, 11, 12).getTime();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let db = new ReadingDatabase(file);
  const connector = new GenericConnector({} as never);
  const registry = new ConnectorRegistry();
  registry.register(connector);
  let sync = new SyncManager(db, registry);
  const raw = (title: string, publishedAt?: number): RawEntry => ({ title, url: `https://example.com/${title}`, publishedAt });
  const old = raw("old", now - 86_400_000);
  const fresh = raw("fresh", now);
  const unknown = raw("unknown");
  const fetch = vi.spyOn(connector, "sync").mockResolvedValue({ entries: [old, fresh, unknown] });
  const query = entryQueryForLibrary("today", undefined, new Date(now));
  const assertToday = (titles: string[]) => {
    const listed = db.listEntries(query);
    expect(listed.map(e => e.title).sort()).toEqual([...titles].sort());
    expect(db.getLibraryCounts(now).today).toBe(titles.length);
    const paged: string[] = [];
    let cursor;
    do {
      const page = db.listEntryPage({ ...query, pageSize: 1, cursor });
      paged.push(...page.entries.map(e => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(listed.map(e => e.id));
  };
  try {
    const source = db.createSource({ title: "New source", url: "https://example.com/feed", kind: "generic", pollingEnabled: true });
    sync.savePreview(source, [old, fresh]);
    assertToday(["fresh"]);
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(sync.syncSource(source.id)).rejects.toThrow("offline");
    expect(db.getSource(source.id)?.lastSuccessfulAt).toBeUndefined();
    await sync.close(); db.close();
    db = new ReadingDatabase(file); sync = new SyncManager(db, registry);
    await sync.syncSource(source.id);
    assertToday(["fresh"]);
    expect(db.listEntries()).toHaveLength(3);
    const later = raw("later-discovered-old", now - 86_400_000);
    const laterUnknown = raw("later-unknown");
    fetch.mockResolvedValue({ entries: [old, fresh, unknown, later, laterUnknown] });
    await sync.syncSource(source.id);
    assertToday(["fresh", "later-discovered-old", "later-unknown"]);
    const shared = db.createSource({ title: "Another source", url: "https://example.com/another", kind: "generic", pollingEnabled: true });
    await sync.syncSource(shared.id);
    assertToday(["fresh", "later-discovered-old", "later-unknown"]);
    await sync.close(); db.close();
    db = new ReadingDatabase(file); sync = new SyncManager(db, registry);
    assertToday(["fresh", "later-discovered-old", "later-unknown"]);
    clock.mockReturnValue(now + 86_400_000);
    await sync.syncSource(source.id);
    expect(db.listEntries(entryQueryForLibrary("today", undefined, new Date(now + 86_400_000)))).toEqual([]);
    expect(db.getLibraryCounts(now + 86_400_000).today).toBe(0);
  } finally {
    await sync.close(); db.close(); clock.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
