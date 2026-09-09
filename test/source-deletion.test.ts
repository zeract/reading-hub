import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";
import type { Entry } from "../src/shared/types";

const addSource = (db: ReadingDatabase, name: string) => db.createSource({ url: `https://example.com/${name}`, title: name, kind: "rss", pollingEnabled: true });
const card = (sourceId: string, id: string): Entry => ({ id, sourceId, title: id, canonicalUrl: `https://example.com/article/${id}`, url: `https://example.com/article/${id}`, contentHash: id, createdAt: 1, read: false, favorite: true });
const serviceFor = (db: ReadingDatabase) => new SourceService(db, undefined as never, { cancelSource: vi.fn() } as never, { clearSession: vi.fn(async () => undefined) } as never);

it("deletes exclusive favorites and tombstones while preserving shared content and its read state", async () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const first = addSource(db, "first"), second = addSource(db, "second");
    db.saveEntries([card(first.id, "saved"), card(first.id, "dismissed"), card(first.id, "shared"), card(first.id, "hidden-shared")]);
    db.saveEntries([card(second.id, "shared"), card(second.id, "hidden-shared")]);
    db.markFavorite("saved", true); db.markFavorite("shared", true);
    db.markRead("shared", true);
    db.dismissEntry("dismissed"); db.dismissEntry("hidden-shared");
    await serviceFor(db).delete(first.id);
    expect(db.getEntry("saved")).toBeUndefined();
    expect(db.getEntry("shared")).toMatchObject({ sourceId: second.id, favorite: true, read: true });
    expect(db.getEntry("shared")?.origins?.map((origin) => origin.sourceId)).toEqual([second.id]);
    expect(db.listEntries({ dismissed: true }).map((entry) => entry.id)).toEqual(["hidden-shared"]);
    // Removing a source is not a permanent global ban on its URLs.
    expect(db.saveEntries([card(second.id, "dismissed")])).toBe(1);
    expect(db.getEntry("dismissed")).toBeDefined();
  } finally { db.close(); }
});

it("rolls back origins, favorites and the source together if deletion fails", () => {
  const db = new ReadingDatabase(":memory:");
  try {
    const first = addSource(db, "rollback"); db.saveEntries([card(first.id, "saved")]);
    db.markFavorite("saved", true);
    const raw = (db as unknown as { db: Sqlite.Database }).db;
    raw.exec("CREATE TRIGGER reject_source_delete BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'Synthetic delete failure'); END");
    expect(() => db.deleteSource(first.id)).toThrow("Synthetic delete failure");
    expect(db.getSource(first.id)).toBeDefined();
    expect(db.getEntry("saved")?.favorite).toBe(true);
    expect(db.getEntry("saved")?.origins).toHaveLength(1);
  } finally { db.close(); }
});

it("cleans legacy unsubscribed sources on restart without touching paused or shared content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reading-hub-unsubscribe-"));
  const file = join(directory, "library.sqlite");
  let db = new ReadingDatabase(file);
  try {
    const first = addSource(db, "legacy"), second = addSource(db, "remaining");
    db.saveEntries([card(first.id, "saved"), card(first.id, "shared")]); db.saveEntries([card(second.id, "shared")]);
    db.markFavorite("saved", true); db.markFavorite("shared", true);
    db.setSubscribed(first.id, false); db.pauseSource(second.id, "Paused by user");
    db.close(); db = new ReadingDatabase(file);
    await serviceFor(db).removeUnsubscribedSources();
    expect(db.getSource(first.id)).toBeUndefined();
    expect(db.getSource(second.id)?.status).toBe("paused");
    expect(db.listEntries().map((entry) => entry.id)).toEqual(["shared"]);
    const revision = db.getLibraryRevision();
    await serviceFor(db).removeUnsubscribedSources();
    expect(db.getLibraryRevision()).toBe(revision);
    db.close(); db = new ReadingDatabase(file);
    expect(db.getEntry("shared")?.origins).toHaveLength(1);
    expect(db.getEntry("saved")).toBeUndefined();
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
