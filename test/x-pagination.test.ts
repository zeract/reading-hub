import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncContext, SyncResult } from "../src/shared/types";
import { XConnector } from "../src/main/x";

const user = { id: "author", name: "Author", username: "author" };
const json = (value: unknown) => new Response(JSON.stringify(value));
const post = (id: string) => ({ id, text: `Post ${id}`, created_at: "2026-09-01T00:00:00Z" });
function fixture(fetcher: (url: string, init?: RequestInit) => Promise<Response>, mode = "following", filePath = ":memory:") {
  const database = new ReadingDatabase(filePath);
  const account = database.saveAccount({ connectorId: "x", displayName: "X", subjectId: "owner", keychainAccount: "x:fixture", scopes: [], status: "active" });
  const source = database.createSource({ url: mode === "profile" ? "https://x.com/author" : "https://api.x.com/2/users/owner/following", title: "X", kind: "x", accountId: account.id, config: { mode, username: "author" }, pollingEnabled: true });
  const connector = new XConnector(database, {
    getConnectorSecret: async () => JSON.stringify({ accessToken: "fixture-only" }),
    setConnectorSecret: async () => "x:fixture"
  }, async () => undefined, fetcher);
  const context: SyncContext = { source, subscription: database.getSubscriptionForSource(source.id)!, account };
  const commit = (result: SyncResult) => {
    database.writeTransaction(() => {
      database.saveEntries(result.entries.map((entry) => connector.normalize(entry, source)));
      if (result.checkpoint) database.saveCheckpoint(context.subscription.id, result.checkpoint);
    });
    context.checkpoint = database.getCheckpoint(context.subscription.id);
  };
  return { database, connector, context, commit };
}

describe("X incremental pagination", () => {
  afterEach(() => vi.useRealTimers());

  it("does not postpone refreshing the following list on every ordinary poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const fetcher = vi.fn(async () => json({ data: [] }));
    const f = fixture(fetcher);
    try {
      const refreshedAt = Date.now() - 5 * 60 * 60_000;
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: refreshedAt, data: { followed: [user], followingRefreshedAt: refreshedAt } };
      f.commit(await f.connector.sync(f.context));
      expect(f.context.checkpoint?.data?.followingRefreshedAt).toBe(refreshedAt);
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await f.connector.sync(f.context);
      expect(fetcher.mock.calls.some(([url]) => url.includes("/following"))).toBe(true);
    } finally { f.database.close(); }
  });

  it("caches a successfully fetched empty following list", async () => {
    const fetcher = vi.fn(async () => json({ data: [] }));
    const f = fixture(fetcher);
    try {
      f.commit(await f.connector.sync(f.context));
      f.commit(await f.connector.sync(f.context));
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it.each(["following", "profile"])("retains the lower bound until every incremental page is saved for %s", async (mode) => {
    const fetcher = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      if (url.includes("/by/username/")) return json({ data: user });
      if (query.get("pagination_token") === "page-two") return json({ data: [post("102"), post("101")] });
      return json({ data: [post("104"), post("103")], meta: { next_token: "page-two" } });
    });
    const f = fixture(fetcher, mode);
    try {
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: Date.now(), sinceId: "100", data: { followed: [user], followingRefreshedAt: Date.now(), sinceByUser: { author: "100" } } };
      f.commit(await f.connector.sync(f.context));
      expect(f.context.checkpoint?.sinceId).toBe("100");
      // Round-trip through SQLite, rather than reusing the connector result.
      f.commit(await f.connector.sync(f.context));
      expect(f.database.listEntries().map((entry) => entry.externalId).sort()).toEqual(["101", "102", "103", "104"]);
      expect(f.context.checkpoint?.sinceId).toBe("104");
      const requests = fetcher.mock.calls.filter(([url]) => url.includes("/tweets"));
      expect(requests).toHaveLength(2);
      expect(requests.map(([url]) => new URL(url).searchParams.get("since_id"))).toEqual(["100", "100"]);
    } finally { f.database.close(); }
  });

  it("resumes saved pagination after restart and preserves progress across a failed page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reading-hub-x-pages-"));
    const filePath = join(dir, "library.sqlite");
    let fail = false;
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.has("pagination_token")) return fail ? new Response("{}", { status: 429 }) : json({ data: [post("101")] });
      return json({ data: [post("102")], meta: { next_token: "next" } });
    });
    const f = fixture(fetcher, "following", filePath);
    let reopened: ReadingDatabase | undefined;
    try {
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: Date.now(), data: { followed: [user], followingRefreshedAt: Date.now(), sinceByUser: { author: "100" } } };
      f.commit(await f.connector.sync(f.context));
      f.database.close();
      reopened = new ReadingDatabase(filePath);
      const connector = new XConnector(reopened, { getConnectorSecret: async () => JSON.stringify({ accessToken: "fixture-only" }), setConnectorSecret: async () => "x:fixture" }, async () => undefined, fetcher);
      const context = { ...f.context, checkpoint: reopened.getCheckpoint(f.context.subscription.id) };
      fail = true;
      await expect(connector.sync(context)).rejects.toThrow("429");
      expect(reopened.getCheckpoint(context.subscription.id)).toEqual(context.checkpoint);
      expect(reopened.listEntries().map((item) => item.externalId)).toEqual(["102"]);
      fail = false;
      const result = await connector.sync(context);
      expect(result.entries.map((item) => item.externalId)).toEqual(["101"]);
      expect(result.checkpoint?.sinceId).toBe("102");
      expect(new URL(fetcher.mock.calls.at(-1)![0]).searchParams.get("since_id")).toBe("100");
    } finally { reopened?.close(); f.database.close(); rmSync(dir, { recursive: true }); }
  });

  it("replays from the committed lower bound if a saved page token is rejected", async () => {
    const fetcher = vi.fn(async (url: string) => new URL(url).searchParams.has("pagination_token")
      ? new Response("{}", { status: 400 }) : json({ data: [post("103"), post("102")] }));
    const f = fixture(fetcher);
    try {
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: Date.now(), data: { followed: [user], followingRefreshedAt: Date.now(), sinceByUser: { author: "100" }, pendingByUser: { author: { cursor: "expired", highWaterId: "102" } } } };
      f.commit(await f.connector.sync(f.context));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.every(([url]) => new URL(url).searchParams.get("since_id") === "100")).toBe(true);
      expect(f.context.checkpoint?.sinceId).toBe("103");
      expect(f.context.checkpoint?.data?.pendingByUser).toEqual({});
    } finally { f.database.close(); }
  });

  it("advances over filtered posts only after the final page, without rounding large post IDs", async () => {
    const high = "9007199254741003";
    const fetcher = vi.fn(async (url: string) => new URL(url).searchParams.has("pagination_token")
      ? json({ data: [post("9007199254741001")] })
      : json({ data: [{ ...post(high), in_reply_to_user_id: "other" }], meta: { next_token: "filtered" } }));
    const f = fixture(fetcher);
    try {
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: Date.now(), data: { followed: [user], followingRefreshedAt: Date.now(), sinceByUser: { author: "9007199254741000" } } };
      f.commit(await f.connector.sync(f.context));
      expect(f.database.listEntries()).toEqual([]);
      f.commit(await f.connector.sync(f.context));
      expect(f.context.checkpoint?.sinceId).toBe(high);
      expect(f.database.listEntries().map((item) => item.externalId)).toEqual(["9007199254741001"]);
    } finally { f.database.close(); }
  });

  it("keeps initial collection to the latest page instead of silently importing the author's archive", async () => {
    const fetcher = vi.fn(async (url: string) => url.includes("/following") ? json({ data: [user] }) : json({ data: [post("200")], meta: { next_token: "older-archive" } }));
    const f = fixture(fetcher);
    try {
      f.commit(await f.connector.sync(f.context));
      expect(f.context.checkpoint?.sinceId).toBe("200");
      expect(f.context.checkpoint?.data?.pendingByUser).toEqual({});
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { f.database.close(); }
  });

  it("rejects a non-advancing post page without replacing the saved checkpoint", async () => {
    const f = fixture(async () => json({ data: [post("102")], meta: { next_token: "same" } }));
    try {
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: Date.now(), data: { followed: [user], followingRefreshedAt: Date.now(), sinceByUser: { author: "100" }, pendingByUser: { author: { cursor: "same", highWaterId: "102" } } } };
      const before = JSON.stringify(f.context.checkpoint);
      await expect(f.connector.sync(f.context)).rejects.toThrow("分页未前进");
      expect(JSON.stringify(f.context.checkpoint)).toBe(before);
    } finally { f.database.close(); }
  });

  it("deduplicates following pages and stops a repeating cursor instead of looping", async () => {
    const fetcher = vi.fn(async () => json({ data: [user], meta: { next_token: "same" } }));
    const f = fixture(fetcher);
    try {
      await expect(f.connector.sync(f.context)).rejects.toThrow("关注列表分页未完成");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(f.context.checkpoint).toBeUndefined();
    } finally { f.database.close(); }
  });

  it("cancels a resumed page without mutating the caller's progress", async () => {
    const controller = new AbortController();
    const f = fixture(async () => { controller.abort(new Error("cancel page")); return json({ data: [post("101")] }); });
    try {
      f.context.checkpoint = { subscriptionId: f.context.subscription.id, updatedAt: Date.now(), data: { followed: [user], followingRefreshedAt: Date.now(), sinceByUser: { author: "100" }, pendingByUser: { author: { cursor: "next", highWaterId: "102" } } } };
      const before = JSON.stringify(f.context.checkpoint);
      await expect(f.connector.sync({ ...f.context, signal: controller.signal })).rejects.toThrow("cancel page");
      expect(JSON.stringify(f.context.checkpoint)).toBe(before);
      expect(f.database.getAccount(f.context.account!.id)?.status).toBe("active");
    } finally { f.database.close(); }
  });
});
