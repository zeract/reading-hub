import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const credentials = vi.hoisted(() => ({ clear: vi.fn(async (_account?: string) => undefined) }));

vi.mock("electron", () => ({ BrowserWindow: class {}, session: {}, shell: {} }));
vi.mock("../src/main/network", () => ({ configureChromiumNetwork: vi.fn(async () => undefined), chromiumFetch: vi.fn(), configureChromiumSession: vi.fn() }));
vi.mock("../src/main/secrets", () => ({ SecretStore: class {
  getConnectorSecret = vi.fn(async () => null);
  setConnectorSecret = vi.fn(async () => "fixture-account");
  clearConnectorSecret = credentials.clear;
} }));
import { createApplicationServices } from "../src/main/app-services";
import { ReadingDatabase } from "../src/main/database";
import { ContentMaintenance } from "../src/main/content-maintenance";
import { ZhihuFollowConnector } from "../src/main/zhihu-follow";

afterEach(() => { vi.restoreAllMocks(); credentials.clear.mockReset(); vi.unstubAllEnvs(); });

describe("application service acquisition", () => {
  it.each(["success", "retry", "audit"])("cleans only retired platform accounts on %s startup", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-account-cleanup-"));
    const file = join(directory, "library.sqlite");
    const db = new ReadingDatabase(file);
    const old = db.saveAccount({ connectorId: "x", displayName: "Legacy", keychainAccount: "x:fixture", scopes: [], status: "expired" });
    const oldXhs = db.saveAccount({ connectorId: "xiaohongshu", displayName: "Legacy", scopes: [], status: "active" });
    const kept = db.saveAccount({ connectorId: "academic", displayName: "Kept", keychainAccount: "academic:fixture", scopes: [], status: "active" });
    db.close();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (mode === "retry") credentials.clear.mockRejectedValueOnce(new Error("fixture-private-keychain-marker"));
    if (mode === "audit") vi.stubEnv("READING_HUB_READER_AUDIT", "1");
    let services: Awaited<ReturnType<typeof createApplicationServices>> | undefined;
    try {
      services = await createApplicationServices(file);
      expect(services.database.getAccount(kept.id)).toBeDefined();
      if (mode === "audit") {
        expect(credentials.clear).not.toHaveBeenCalled();
        expect(services.database.getAccount(old.id)).toBeDefined();
        expect(services.database.getAccount(oldXhs.id)).toBeDefined();
      } else {
        expect(credentials.clear.mock.calls.map(([key]) => key)).toEqual(["x:fixture", undefined]);
        expect(services.database.getAccount(oldXhs.id)).toBeUndefined();
        if (mode === "retry") {
          expect(services.database.getAccount(old.id)).toBeDefined();
          expect(warnings).toHaveBeenCalledWith("Reading Hub 未完成 1 项旧授权清理；将在下次启动时重试。");
          expect(JSON.stringify(warnings.mock.calls)).not.toContain("fixture-private-keychain-marker");
          await services.close(); services = undefined;
          services = await createApplicationServices(file);
          expect(credentials.clear.mock.calls.map(([key]) => key)).toEqual(["x:fixture", undefined, "x:fixture"]);
        }
        expect(services.database.getAccount(old.id)).toBeUndefined();
      }
    } finally { if (services) await services.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not clear another provider's secret from a damaged retired account", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reading-hub-account-ownership-"));
    const file = join(directory, "library.sqlite");
    const db = new ReadingDatabase(file);
    const account = db.saveAccount({ connectorId: "x", displayName: "Damaged", keychainAccount: "ai:openai", scopes: [], status: "expired" });
    db.close();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let services: Awaited<ReturnType<typeof createApplicationServices>> | undefined;
    try {
      services = await createApplicationServices(file);
      expect(credentials.clear).not.toHaveBeenCalled();
      expect(services.database.getAccount(account.id)).toBeDefined();
      expect(warnings).toHaveBeenCalledWith("Reading Hub 未完成 1 项旧授权清理；将在下次启动时重试。");
      expect(JSON.stringify(warnings.mock.calls)).not.toContain("ai:openai");
    } finally { if (services) await services.close(); rmSync(directory, { recursive: true, force: true }); }
  });

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
