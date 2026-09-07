import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {}, shell: {} }));
vi.mock("../src/main/network", () => ({ configureChromiumNetwork: vi.fn(async () => undefined), chromiumFetch: vi.fn(), configureChromiumSession: vi.fn() }));
vi.mock("../src/main/secrets", () => ({ SecretStore: class {
  getConnectorSecret = vi.fn(async () => null);
  setConnectorSecret = vi.fn(async () => "fixture-account");
} }));
import { createApplicationServices } from "../src/main/app-services";
import { ReadingDatabase } from "../src/main/database";
import { ContentMaintenance } from "../src/main/content-maintenance";
import { ZhihuFollowConnector } from "../src/main/zhihu-follow";

afterEach(() => vi.restoreAllMocks());

describe("application service acquisition", () => {
  it.each(["resumeLegacyAutoPausedSources", "beginLibrarySession"] as const)("closes its database if %s fails before ownership is returned", async (method) => {
    let opened: ReadingDatabase | undefined;
    const failure = new Error("Synthetic startup write failure");
    vi.spyOn(ReadingDatabase.prototype, method).mockImplementationOnce(function (this: ReadingDatabase) {
      opened = this;
      throw failure;
    });
    try {
      await expect(createApplicationServices(":memory:")).rejects.toBe(failure);
      expect(opened).toBeDefined();
      expect(() => opened!.listSources()).toThrow(/not open/);
      const retry = await createApplicationServices(":memory:");
      expect(retry.database.listSources()).toEqual([]);
      await retry.close();
    } finally { opened?.close(); }
  });

  it.each(["maintenance", "callback"] as const)("does not consume the previous visit when late %s setup fails", async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-startup-"));
    const file = join(directory, "library.sqlite");
    const initial = new ReadingDatabase(file);
    initial.beginLibrarySession(100);
    const source = initial.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
    initial.saveEntries([{ id: "between-visits", sourceId: source.id, url: "https://example.com/article", canonicalUrl: "https://example.com/article",
      title: "Fixture article", contentHash: "fixture", publishedAt: 140, createdAt: 150, read: false, favorite: false }]);
    initial.markFavorite("between-visits", true);
    initial.close();
    const clock = vi.spyOn(Date, "now").mockReturnValue(200);
    let opened: ReadingDatabase | undefined;
    const original = ReadingDatabase.prototype.resumeLegacyAutoPausedSources;
    vi.spyOn(ReadingDatabase.prototype, "resumeLegacyAutoPausedSources").mockImplementation(function (this: ReadingDatabase, now) {
      opened = this;
      return original.call(this, now);
    });
    const failure = new Error("Synthetic late startup failure");
    if (phase === "maintenance") vi.spyOn(ContentMaintenance.prototype, "runStartupMaintenance").mockImplementationOnce(() => { throw failure; });
    else vi.spyOn(ZhihuFollowConnector.prototype, "setOnAuthenticated").mockImplementationOnce(() => { throw failure; });
    let retry: Awaited<ReturnType<typeof createApplicationServices>> | undefined;
    let failedDatabase: ReadingDatabase | undefined;
    try {
      await expect(createApplicationServices(file)).rejects.toBe(failure);
      failedDatabase = opened;
      clock.mockReturnValue(300);
      retry = await createApplicationServices(file);
      expect(retry.database.getLibraryCounts()).toMatchObject({ newArrivals: 1, favorite: 1 });
      expect(() => failedDatabase!.listSources()).toThrow(/not open/);
      expect(retry.database.getEntry("between-visits")).toMatchObject({ sourceId: source.id, createdAt: 150, publishedAt: 140 });
      await retry.close(); retry = undefined;
      clock.mockReturnValue(400);
      retry = await createApplicationServices(file);
      expect(retry.database.getLibraryCounts()).toMatchObject({ newArrivals: 0, favorite: 1 });
    } finally {
      if (retry) await retry.close();
      failedDatabase?.close();
      opened?.close();
      rmSync(directory, { recursive: true });
    }
  });
});
