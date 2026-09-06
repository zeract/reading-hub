import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidJsonResponseError, requestJsonWithTimeout } from "../src/main/cancellation";
import { AcademicAuthorConnector } from "../src/main/academic";
import { ReadingDatabase } from "../src/main/database";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { SyncManager } from "../src/main/sync-manager";
import { XConnector } from "../src/main/x";
import { ZhihuConnector } from "../src/main/zhihu";
import { chromiumFetch } from "../src/main/network";
vi.mock("../src/main/network", () => ({ chromiumFetch: vi.fn() }));

describe("JSON response contract", () => {
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

  it.each(["<html>temporary gateway failure</html>", '{"data":', ""])("rejects malformed successful body %j", async (body) => {
    await expect(requestJsonWithTimeout(async () => new Response(body), "https://example.com/api", {}, undefined, 1000)).rejects.toThrow();
  });

  it.each(["academic", "x"] as const)("does not commit %s success or checkpoint on a malformed response", async (kind) => {
    const database = new ReadingDatabase(":memory:");
    const fetcher = vi.fn(async () => new Response("<html>fixture gateway error</html>"));
    const account = database.saveAccount({ connectorId: "x", displayName: "Fixture", subjectId: "owner", keychainAccount: "x:fixture", scopes: [], status: "active" });
    const source = database.createSource({ url: "https://example.com/api", title: "Fixture", kind, accountId: kind === "x" ? account.id : undefined, config: { authorName: "Fixture", openAlexId: "A1" }, pollingEnabled: true });
    const subscription = database.getSubscriptionForSource(source.id)!;
    database.saveCheckpoint(subscription.id, { sinceId: "100", data: { retained: true } });
    const before = database.getCheckpoint(subscription.id);
    const registry = new ConnectorRegistry();
    registry.register(kind === "academic" ? new AcademicAuthorConnector(fetcher) : new XConnector(database, {
      getConnectorSecret: async () => JSON.stringify({ accessToken: "fixture-only" }), setConnectorSecret: async () => "x:fixture"
    }, async () => undefined, fetcher));
    const manager = new SyncManager(database, registry);
    try {
      await expect(manager.syncSource(source.id)).rejects.toThrow();
      expect(database.getCheckpoint(subscription.id)).toEqual(before);
      expect(database.getSource(source.id)).toMatchObject({ status: "error", failureCount: 1 });
      expect(database.getSource(source.id)?.lastSuccessfulAt).toBeUndefined();
      expect(database.listEntries()).toEqual([]);
      expect(database.getAccount(account.id)?.status).toBe("active");
    } finally { await manager.close(); database.close(); }
  });

  it("returns genuine empty JSON results without treating them as corruption", async () => {
    const result = await requestJsonWithTimeout(async () => new Response('{"data":[]}'), "https://example.com/api", {}, undefined, 1000);
    expect(result.payload).toEqual({ data: [] });
  });

  it.each([400, 401, 403, 429, 503])("preserves HTTP %s when its error body is not JSON", async (status) => {
    const result = await requestJsonWithTimeout(async () => new Response("<html>upstream error</html>", { status }), "https://example.com/api", {}, undefined, 1000);
    expect(result.response.status).toBe(status);
    expect(result.payload).toEqual({});
  });

  it("does not retain parser messages or response contents in diagnostics", async () => {
    const response = { ok: true, json: async () => { throw new SyntaxError("fixture-private-response-marker"); } } as unknown as Response;
    const failure = await requestJsonWithTimeout(async () => response, "https://example.com/api", {}, undefined, 1000).catch((error) => error);
    expect(failure).toBeInstanceOf(InvalidJsonResponseError);
    expect(failure.message).toContain("格式错误");
    expect(failure.cause).toBeUndefined();
    expect(String(failure.stack)).not.toContain("fixture-private-response-marker");
  });

  it("keeps the timeout active through body consumption and removes its timer", async () => {
    vi.useFakeTimers();
    const response = { ok: true, json: vi.fn(() => new Promise(() => undefined)) } as unknown as Response;
    const pending = requestJsonWithTimeout(async () => response, "https://example.com/api", {}, undefined, 100);
    const rejected = expect(pending).rejects.toThrow("请求响应超时");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(response.json).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation instead of turning it into malformed JSON", async () => {
    const controller = new AbortController();
    const response = { ok: true, json: async () => { controller.abort(new Error("cancel parsing")); throw new SyntaxError("incomplete"); } } as unknown as Response;
    await expect(requestJsonWithTimeout(async () => response, "https://example.com/api", {}, controller.signal, 1000)).rejects.toThrow("cancel parsing");
  });

  it("observes a transport rejection even if obtaining its promise synchronously cancels the request", async () => {
    const controller = new AbortController();
    const fetcher = async () => {
      controller.abort(new Error("cancel transport"));
      throw new Error("fixture transport failure");
    };
    await expect(requestJsonWithTimeout(fetcher, "https://example.com/api", {}, controller.signal, 1000)).rejects.toThrow("cancel transport");
  });

  it.each([200, 401])("keeps safe Zhihu error handling for non-JSON HTTP %s", async (status) => {
    vi.useFakeTimers();
    vi.mocked(chromiumFetch).mockImplementation(async () => new Response("fixture-private-response-marker", { status }));
    const pending = new ZhihuConnector(async () => "fixture-only").fetchEntries();
    const failure = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(800);
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(status === 200 ? "格式错误" : "授权无效");
    expect(error.message).not.toContain("fixture-private-response-marker");
    expect(chromiumFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
