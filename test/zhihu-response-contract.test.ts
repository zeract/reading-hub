import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { ZhihuConnector } from "../src/main/zhihu";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager } from "../src/main/sync-manager";
const connector = () => new ZhihuConnector(async () => "fixture-secret");
const page = (Data: unknown) => new Response(JSON.stringify({ Code: 0, Data }));
beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("Zhihu response boundaries", () => {
  it("does not retry or expose an unsafe redirect", async () => {
    vi.useFakeTimers();
    network.fetch.mockImplementation(async () => new Response(null, { status: 307, headers: { location: "https://other.example/fixture-secret" } }));
    const pending = connector().fetchEntries().catch((error) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error.message).toContain("允许范围");
    expect(error.message).not.toContain("fixture-secret");
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mistake a missing collection for an empty success", async () => {
    network.fetch.mockImplementation(async () => page({}));
    await expect(connector().fetchEntries()).rejects.toThrow("响应无效");
  });

  it("rejects a missing followee identity rather than producing the string undefined", async () => {
    network.fetch.mockImplementation(async () => page({ Items: [{ Url: "https://www.zhihu.com/people/example" }] }));
    await expect(connector().fetchFollowees()).rejects.toThrow("响应无效");
  });

  it("stops a repeated cursor before requesting the same page again", async () => {
    network.fetch.mockResolvedValueOnce(page({ Items: [], Paging: { IsEnd: false, NextOffset: "next" } }));
    network.fetch.mockResolvedValueOnce(page({ Items: [], Paging: { IsEnd: false, NextOffset: "next" } }));
    network.fetch.mockResolvedValueOnce(page({ Items: [] }));
    await expect(connector().fetchFollowees()).rejects.toThrow("分页");
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry an authorization rejection", async () => {
    vi.useFakeTimers();
    network.fetch.mockImplementation(async () => new Response("", { status: 401 }));
    const pending = expect(connector().fetchEntries()).rejects.toThrow("授权无效");
    await vi.runAllTimersAsync();
    await pending;
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose raw transport details", async () => {
    vi.useFakeTimers();
    network.fetch.mockRejectedValue(new Error("fixture-secret echoed by transport"));
    const pending = connector().fetchEntries().catch((error) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error.message).not.toContain("fixture-secret");
  });

  it.each([null, [], {}, { Code: "0", Data: { Items: [] } }, { Code: 0, Data: null }, { Code: 0, Data: { Items: [null] } }])("rejects malformed envelope or collection %j without retry", async (value) => {
    network.fetch.mockImplementation(async () => new Response(JSON.stringify(value)));
    await expect(connector().fetchEntries()).rejects.toThrow("响应无效");
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { Url: "https://example.com/post", Title: 12 },
    { Url: "https://example.com/post", Author: [] },
    { Url: "https://example.com/post", CreatedAt: "yesterday" },
    { Url: "http://127.0.0.1/post" }
  ])("rejects an invalid content record without leaking its values", async (item) => {
    network.fetch.mockImplementation(async () => page({ Items: [item] }));
    await expect(connector().fetchEntries()).rejects.toThrow("知乎接口响应无效");
  });

  it("preserves valid content, explicit empty results and items without a URL", async () => {
    network.fetch.mockResolvedValueOnce(page({ Items: [{ Url: "https://www.zhihu.com/question/1/answer/2", Title: " A  title ", Summary: "summary", Author: { Name: "Author" }, CreatedAt: 123 }, {}] }));
    expect(await connector().fetchEntries()).toEqual([{ url: "https://www.zhihu.com/question/1/answer/2", title: "A title", summary: "summary", author: "Author", publishedAt: 123000 }]);
    network.fetch.mockResolvedValueOnce(page({ Items: [] }));
    expect(await connector().fetchRecentCollections()).toEqual([]);
  });

  it("deduplicates followees across pages without using duplicates to meet the limit", async () => {
    const item = (id: string) => ({ UrlToken: id, Url: `https://www.zhihu.com/people/${id}`, Fullname: id });
    network.fetch.mockResolvedValueOnce(page({ Items: [item("one")], Paging: { IsEnd: false, NextOffset: "cursor/+" } }));
    network.fetch.mockResolvedValueOnce(page({ Items: [item("one"), item("two")], Paging: { IsEnd: false, NextOffset: "next" } }));
    network.fetch.mockResolvedValueOnce(page({ Items: [item("three")], Paging: { IsEnd: true } }));
    expect((await connector().fetchFollowees(3)).map((entry) => entry.urlToken)).toEqual(["one", "two", "three"]);
    expect(network.fetch.mock.calls[1][0]).toContain("Offset=cursor%2F%2B");
  });

  it("bounds pages even when empty pages always return a new cursor", async () => {
    let next = 0;
    network.fetch.mockImplementation(async () => page({ Items: [], Paging: { IsEnd: false, NextOffset: String(++next) } }));
    await expect(connector().fetchFollowees()).rejects.toThrow("分页异常");
    expect(network.fetch).toHaveBeenCalledTimes(20);
  });

  it.each([{ IsEnd: false }, { IsEnd: "true" }, { NextOffset: {} }])("rejects malformed pagination %j", async (Paging) => {
    network.fetch.mockResolvedValueOnce(page({ Items: [], Paging }));
    await expect(connector().fetchFollowees()).rejects.toThrow("响应无效");
  });

  it.each([403, 429, 400])("does not immediately retry HTTP %i", async (status) => {
    network.fetch.mockResolvedValueOnce(new Response("", { status }));
    await expect(connector().fetchEntries()).rejects.toThrow();
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "server", "provider"])("retries a transient %s failure once", async (kind) => {
    vi.useFakeTimers();
    if (kind === "network") network.fetch.mockRejectedValueOnce(new Error("fixture raw transport"));
    else network.fetch.mockResolvedValueOnce(kind === "server" ? new Response("", { status: 503 }) : new Response(JSON.stringify({ Code: 90001 })));
    network.fetch.mockResolvedValueOnce(page({ Items: [] }));
    const result = connector().fetchEntries();
    await vi.advanceTimersByTimeAsync(800);
    expect(await result).toEqual([]);
    expect(network.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while waiting for the secret and ignores its late value", async () => {
    let finish!: (value: string) => void;
    const secret = new Promise<string>((resolve) => { finish = resolve; });
    const controller = new AbortController();
    const result = new ZhihuConnector(() => secret).fetchEntries(controller.signal);
    controller.abort(new Error("cancel secret wait"));
    await expect(result).rejects.toThrow("cancel secret wait");
    finish("fixture-secret");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("cancels during retry delay without another request", async () => {
    vi.useFakeTimers();
    network.fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    const controller = new AbortController();
    const result = connector().fetchEntries(controller.signal);
    const rejected = expect(result).rejects.toThrow("cancel retry");
    await vi.advanceTimersByTimeAsync(400);
    controller.abort(new Error("cancel retry"));
    await rejected;
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a fixed error for secret-store failures", async () => {
    await expect(new ZhihuConnector(async () => { throw new Error("fixture-secret"); }).fetchEntries()).rejects.toThrow("无法读取知乎授权配置");
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("does not commit a false empty success and can recover on retry", async () => {
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({ url: "https://developer.zhihu.com/api/v1/user/contents", title: "Fixture", kind: "zhihu", pollingEnabled: true });
    const subscription = database.getSubscriptionForSource(source.id)!;
    database.saveCheckpoint(subscription.id, { data: { retained: true } });
    const before = database.getCheckpoint(subscription.id);
    const registry = new ConnectorRegistry();
    registry.register(connector());
    const manager = new SyncManager(database, registry);
    network.fetch.mockImplementation(async () => page({}));
    try {
      await expect(manager.syncSource(source.id)).rejects.toThrow("响应无效");
      expect(database.getCheckpoint(subscription.id)).toEqual(before);
      expect(database.getSource(source.id)).toMatchObject({ failureCount: 1, status: "error" });
      expect(database.getSource(source.id)?.lastSuccessfulAt).toBeUndefined();
      expect(database.listEntries()).toEqual([]);
      network.fetch.mockImplementation(async () => page({ Items: [] }));
      await manager.syncSource(source.id);
      expect(database.getSource(source.id)).toMatchObject({ failureCount: 0, status: "active" });
      expect(database.getSource(source.id)?.lastSuccessfulAt).toBeDefined();
    } finally { await manager.close(); database.close(); }
  });

  it("keeps valid own content and existing followees when optional responses are invalid", async () => {
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({ url: "https://developer.zhihu.com/api/v1/user/contents", title: "Fixture", kind: "zhihu", pollingEnabled: true });
    const existing = { urlToken: "existing", fullname: "Existing", url: "https://www.zhihu.com/people/existing", updatedAt: 1 };
    database.upsertFollowees([existing]);
    const registry = new ConnectorRegistry();
    registry.register(connector());
    const manager = new SyncManager(database, registry);
    const saveFollowees = vi.spyOn(database, "upsertFollowees");
    network.fetch.mockImplementation(async (url: string) => url.includes("/contents")
      ? page({ Items: [{ Url: "https://zhuanlan.zhihu.com/p/1", Title: "Fixture own content", CreatedAt: 123 }] })
      : url.includes("/followees")
        ? page({ Items: [{ UrlToken: "partial", Url: "https://www.zhihu.com/people/partial" }], Paging: { IsEnd: false, NextOffset: "0" } })
        : page({}));
    try {
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 1 });
      expect(database.listEntries(source.id)).toHaveLength(1);
      expect(saveFollowees).not.toHaveBeenCalled();
      expect(await manager.syncSource(source.id)).toMatchObject({ inserted: 0 });
      expect(database.listEntries(source.id)).toHaveLength(1);
      expect(database.getSource(source.id)?.status).toBe("active");
    } finally { await manager.close(); database.close(); }
  });

  it("starts again from the first page after a malformed continuation", async () => {
    network.fetch.mockResolvedValueOnce(page({ Items: [], Paging: { IsEnd: false, NextOffset: "later" } }));
    network.fetch.mockResolvedValueOnce(page({ Items: null }));
    await expect(connector().fetchFollowees()).rejects.toThrow("响应无效");
    network.fetch.mockResolvedValueOnce(page({ Items: [] }));
    expect(await connector().fetchFollowees()).toEqual([]);
    expect(network.fetch.mock.calls[2][0]).toContain("Offset=0&");
  });

  it("does not inspect the secret or fetch when already cancelled", async () => {
    const secret = vi.fn(async () => "fixture-secret");
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await expect(new ZhihuConnector(secret).fetchEntries(controller.signal)).rejects.toThrow("already stopped");
    expect(secret).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });
});
