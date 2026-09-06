import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { XConnector } from "../src/main/x";
import { ReadingDatabase } from "../src/main/database";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";

const user = { id: "author", name: "Author", username: "author" };
const json = (payload: unknown) => new Response(JSON.stringify(payload));
function fixture(payload: unknown, mode = "following", refreshFollowing = false, filePath = ":memory:") {
  const database = new ReadingDatabase(filePath);
  const account = database.saveAccount({ connectorId: "x", displayName: "Fixture", subjectId: "owner", keychainAccount: "x:fixture", scopes: [], status: "active" });
  const source = database.createSource({ url: mode === "profile" ? "https://x.com/author" : "https://api.x.com/2/users/owner/following", title: "X", kind: "x", accountId: account.id, config: { mode, username: "author" }, pollingEnabled: true });
  const subscription = database.getSubscriptionForSource(source.id)!;
  database.saveCheckpoint(subscription.id, { sinceId: "100", data: {
    followed: [user], followingRefreshedAt: refreshFollowing ? 1 : Date.now(), sinceByUser: { author: "100" },
    pendingByUser: { author: { cursor: "next", highWaterId: "104" } }, pendingPosts: { cursor: "next", highWaterId: "104" }
  } });
  const fetcher = vi.fn(async (url: string) => url.includes("/by/username/") ? json({ data: user }) : json(payload));
  const secrets = { getConnectorSecret: async () => JSON.stringify({ accessToken: "fixture-only" }), setConnectorSecret: vi.fn(async () => "x:fixture") };
  const connector = new XConnector(database, secrets, async () => undefined, fetcher);
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const manager = new SyncManager(database, registry);
  return { database, source, account, subscription, connector, manager, fetcher, secrets, close: async () => { await manager.close(); database.close(); } };
}

describe("X response completeness", () => {
  it.each(["following", "profile"])("does not finish a pending %s page when HTTP 200 omits its collection", async (mode) => {
    const run = fixture({}, mode);
    const checkpoint = run.database.getCheckpoint(run.subscription.id);
    try {
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow();
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(run.database.getSource(run.source.id)).toMatchObject({ status: "error", failureCount: 1 });
      expect(run.database.getSource(run.source.id)?.lastSuccessfulAt).toBeUndefined();
      expect(run.database.getAccount(run.account.id)?.status).toBe("active");
    } finally { await run.close(); }
  });

  it("does not replace the cached following list with an incomplete response", async () => {
    const run = fixture({}, "following", true);
    const checkpoint = run.database.getCheckpoint(run.subscription.id);
    try {
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow();
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(run.fetcher).toHaveBeenCalledTimes(1);
    } finally { await run.close(); }
  });

  it("does not accept partial errors as a successful final page", async () => {
    const run = fixture({ data: [{ id: "101", text: "Fixture post" }], errors: [{ detail: "fixture-private-details" }] });
    const checkpoint = run.database.getCheckpoint(run.subscription.id);
    try {
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow();
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(run.database.listEntries()).toEqual([]);
      expect(run.database.getSource(run.source.id)?.lastError).not.toContain("fixture-private-details");
    } finally { await run.close(); }
  });

  it.each([
    null, [], { errors: "fixture-private-details" }, { errors: [], data: null },
    { data: [] , meta: null }, { data: [], meta: [] }, { data: [], meta: { result_count: "0" } },
    { data: [], meta: { result_count: 1 } }, { data: [], meta: { next_token: 123 } },
    { data: [], meta: { next_token: " " } }, { data: [null] }, { data: [{ id: "101" }] },
    { data: [{ id: "invalid-id", text: "Fixture" }] }, { data: [{ id: 101, text: "Fixture" }] },
    { data: [{ id: "101", text: "Fixture" }, { text: "Missing identity" }] }
  ])("rejects invalid page shape without advancing progress: %j", async (payload) => {
    const run = fixture(payload);
    const checkpoint = run.database.getCheckpoint(run.subscription.id);
    try {
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow("数据不完整或格式错误");
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(run.database.listEntries()).toEqual([]);
      expect(run.database.getAccount(run.account.id)?.status).toBe("active");
      expect(run.secrets.setConnectorSecret).not.toHaveBeenCalled();
      expect(run.database.getSource(run.source.id)?.lastError).not.toContain("fixture-private-details");
    } finally { await run.close(); }
  });

  it.each([{ data: [] }, { meta: { result_count: 0 } }])("accepts a confirmed empty final page: %j", async (payload) => {
    const run = fixture(payload);
    try {
      await run.manager.syncSource(run.source.id);
      expect(run.database.getCheckpoint(run.subscription.id)).toMatchObject({ sinceId: "104", data: { pendingByUser: {} } });
      expect(run.database.getSource(run.source.id)).toMatchObject({ status: "active", failureCount: 0 });
    } finally { await run.close(); }
  });

  it("continues through a zero-result page when the API supplies a next cursor", async () => {
    const run = fixture({ meta: { result_count: 0, next_token: "third-page" } });
    try {
      await run.manager.syncSource(run.source.id);
      expect(run.database.getCheckpoint(run.subscription.id)).toMatchObject({ sinceId: "100", data: { pendingByUser: { author: { cursor: "third-page", highWaterId: "104" } } } });
      run.fetcher.mockImplementation(async (url) => {
        expect(new URL(url).searchParams.get("pagination_token")).toBe("third-page");
        return json({ data: [{ id: "101", text: "Fixture post" }], meta: { result_count: 1 } });
      });
      await run.manager.syncSource(run.source.id);
      expect(run.database.getCheckpoint(run.subscription.id)?.sinceId).toBe("104");
      expect(run.database.listEntries().map((entry) => entry.externalId)).toEqual(["101"]);
    } finally { await run.close(); }
  });

  it("rejects an invalid followee instead of caching a shortened list", async () => {
    const run = fixture({ data: [user, { id: "another-user" }] }, "following", true);
    const checkpoint = run.database.getCheckpoint(run.subscription.id);
    try {
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow("数据不完整或格式错误");
      expect(run.database.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(run.fetcher).toHaveBeenCalledTimes(1);
    } finally { await run.close(); }
  });

  it("caches an explicitly zero-result following response", async () => {
    const run = fixture({ meta: { result_count: 0 } }, "following", true);
    try {
      await run.manager.syncSource(run.source.id);
      await run.manager.syncSource(run.source.id);
      expect(run.fetcher).toHaveBeenCalledTimes(1);
      expect(run.database.getCheckpoint(run.subscription.id)?.data?.followed).toEqual([]);
    } finally { await run.close(); }
  });

  it.each(["identity", "permission"])("does not store credentials after an invalid authorization %s response", async (stage) => {
    const run = fixture({});
    vi.spyOn(run.connector as unknown as { waitForAuthorizationCode(): Promise<string> }, "waitForAuthorizationCode").mockResolvedValue("fixture-code");
    run.fetcher.mockImplementation(async (url) => {
      if (url.includes("oauth2/token")) return json({ access_token: "fixture-only" });
      if (url.endsWith("/users/me")) return json({ data: stage === "identity" ? { id: 123, username: "fixture" } : user });
      return json({ errors: [{ detail: "fixture-private-details" }] });
    });
    try {
      await expect(run.connector.authorizeWithClientId("fixture-client")).rejects.toThrow();
      expect(run.secrets.setConnectorSecret).not.toHaveBeenCalled();
      expect(run.database.getAccount(run.account.id)?.status).toBe("active");
    } finally { await run.close(); }
  });


  it("resumes the retained page after a malformed response and database restart", async () => {
    const folder = mkdtempSync(join(tmpdir(), "reading-hub-x-contract-"));
    const filePath = join(folder, "fixture.sqlite");
    const run = fixture({}, "following", false, filePath);
    let reopened: ReadingDatabase | undefined;
    let manager: SyncManager | undefined;
    try {
      const checkpoint = run.database.getCheckpoint(run.subscription.id);
      await expect(run.manager.syncSource(run.source.id)).rejects.toThrow("数据不完整或格式错误");
      const failed = run.database.getSource(run.source.id)!;
      expect(failed.nextCheckAt).toBeGreaterThan(failed.lastCheckedAt!);
      await run.close();
      reopened = new ReadingDatabase(filePath);
      expect(reopened.getCheckpoint(run.subscription.id)).toEqual(checkpoint);
      expect(reopened.getSource(run.source.id)).toMatchObject({ status: "error", failureCount: 1 });
      const registry = new ConnectorRegistry();
      registry.register(new XConnector(reopened, run.secrets, async () => undefined, async (url) => {
        const query = new URL(url).searchParams;
        expect(query.get("since_id")).toBe("100");
        // The first retry resumes the same cursor; the following poll uses
        // the committed high-water mark, so only run the retry here.
        expect(query.get("pagination_token")).toBe("next");
        return json({ data: [{ id: "101", text: "Fixture recovered post", created_at: "2026-09-01T00:00:00Z" }] });
      }));
      manager = new SyncManager(reopened, registry);
      await manager.syncSource(run.source.id);
      expect(reopened.getCheckpoint(run.subscription.id)).toMatchObject({ sinceId: "104", data: { pendingByUser: {} } });
      expect(reopened.listEntries().map((entry) => entry.externalId)).toEqual(["101"]);
      expect(reopened.getSource(run.source.id)).toMatchObject({ status: "active", failureCount: 0 });
      expect(reopened.getAccount(run.account.id)?.status).toBe("active");
    } finally {
      await manager?.close(); reopened?.close(); await run.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

});
