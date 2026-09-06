import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const http = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("node:http", () => http);
import { XConnector } from "../src/main/x";

const state = "fixture-state";
const authorizationUrl = "https://x.com/i/oauth2/authorize?state=fixture-state";
let receive: (request: unknown, response: unknown) => void;
let server: EventEmitter & { listen: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> };
function response() {
  const result = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() });
  result.writeHead.mockReturnValue(result);
  result.end.mockImplementation(() => { queueMicrotask(() => result.emit("finish")); return result; });
  return result;
}
function begin(open = vi.fn(async () => undefined), signal?: AbortSignal) {
  const connector = new XConnector({} as never, {} as never, open);
  const callback = connector as unknown as { waitForAuthorizationCode(url: string, state: string, signal?: AbortSignal): Promise<string> };
  const pending = callback.waitForAuthorizationCode(authorizationUrl, state, signal);
  const outcome = pending.then((code) => ({ code }), (error: Error) => ({ error }));
  return { pending, outcome, open };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  server = Object.assign(new EventEmitter(), { listen: vi.fn((_port, _host, ready) => { queueMicrotask(ready); return server; }), close: vi.fn(() => { server.emit("close"); return server; }), closeAllConnections: vi.fn() });
  http.createServer.mockImplementation((listener) => { receive = listener; return server; });
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("X OAuth callback lifecycle", () => {
  it("clears the timeout when binding the loopback port fails", async () => {
    server.listen.mockImplementation(() => { queueMicrotask(() => server.emit("error", Object.assign(new Error("fixture-private-details"), { code: "EADDRINUSE" }))); return server; });
    const run = begin();
    await expect(run.pending).rejects.toThrow("授权回调");
    expect(vi.getTimerCount()).toBe(0);
    expect(run.open).not.toHaveBeenCalled();
  });

  it("ignores an unrelated state and still accepts the real callback", async () => {
    const run = begin();
    await flush();
    const unrelated = response();
    receive({ method: "GET", url: "/x/callback?state=other&code=unrelated" }, unrelated);
    receive({ method: "GET", url: `/x/callback?state=${state}&code=fixture-code` }, response());
    expect(await run.outcome).toEqual({ code: "fixture-code" });
    expect(unrelated.writeHead.mock.calls[0][0]).toBe(400);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed request targets without throwing out of the HTTP handler", async () => {
    const run = begin();
    await flush();
    expect(() => receive({ method: "GET", url: "http://[" }, response())).not.toThrow();
    receive({ method: "GET", url: `/x/callback?state=${state}&code=fixture-code` }, response());
    expect(await run.outcome).toEqual({ code: "fixture-code" });
  });

  it("does not expose arbitrary provider error text", async () => {
    const run = begin();
    await flush();
    receive({ method: "GET", url: `/x/callback?state=${state}&error=fixture-private-details` }, response());
    const result = await run.outcome;
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error.message).not.toContain("fixture-private-details");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { method: "POST", url: `/x/callback?state=${state}&code=ignored`, status: 405 },
    { method: "GET", url: "/favicon.ico", status: 404 },
    { method: "GET", url: `http://other.example/x/callback?state=${state}&code=ignored`, status: 404 },
    { method: "GET", url: `/x/callback?state=${state}&state=${state}&code=ignored`, status: 400 }
  ])("keeps waiting after an unrelated callback request: %j", async (request) => {
    const run = begin();
    await flush();
    const rejected = response();
    receive(request, rejected);
    expect(rejected.writeHead.mock.calls[0][0]).toBe(request.status);
    expect(server.close).not.toHaveBeenCalled();
    receive({ method: "GET", url: `/x/callback?state=${state}&code=fixture-code` }, response());
    expect(await run.outcome).toEqual({ code: "fixture-code" });
    expect(server.listen).toHaveBeenCalledWith(43119, "127.0.0.1", expect.any(Function));
  });

  it.each(["", "&code=one&code=two", "&code=one&error=refused"])("finishes a matching but invalid callback safely: %s", async (suffix) => {
    const run = begin();
    await flush();
    receive({ method: "GET", url: `/x/callback?state=${state}${suffix}` }, response());
    expect(await run.outcome).toHaveProperty("error");
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(server.closeAllConnections).toHaveBeenCalled();
  });

  it("cancels a waiting callback and removes the listener and timeout", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const run = begin(undefined, controller.signal);
    await flush();
    controller.abort(new Error("fixture cancel"));
    await expect(run.pending).rejects.toThrow("fixture cancel");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("does not open a browser if cancellation wins before the port is ready", async () => {
    let ready!: () => void;
    server.listen.mockImplementation((_port, _host, callback) => { ready = callback; return server; });
    const controller = new AbortController();
    const run = begin(undefined, controller.signal);
    controller.abort(new Error("fixture cancel"));
    ready();
    await expect(run.pending).rejects.toThrow("fixture cancel");
    expect(run.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up on timeout and ignores a late browser-opening failure", async () => {
    let rejectOpen!: (error: Error) => void;
    const run = begin(vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOpen = reject; })));
    await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(run.pending).rejects.toThrow("等待 X 授权超时");
    rejectOpen(new Error("fixture-private-details"));
    await flush();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports browser launch failure without retaining its URL or exception", async () => {
    const run = begin(vi.fn(async () => { throw new Error("fixture-private-details"); }));
    await expect(run.pending).rejects.toThrow("无法打开 X 授权页面");
    const outcome = await run.outcome;
    expect("error" in outcome && outcome.error.message).not.toContain("fixture-private-details");
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates cancellation past the callback into the token exchange", async () => {
    const open = vi.fn(async (_url: string) => undefined);
    const fetcher = vi.fn(async () => new Promise<Response>(() => undefined));
    const secrets = { getConnectorSecret: vi.fn(), setConnectorSecret: vi.fn() };
    const connector = new XConnector({} as never, secrets, open, fetcher);
    const controller = new AbortController();
    const pending = connector.authorizeWithClientId("fixture-client", controller.signal);
    const rejected = expect(pending).rejects.toThrow("fixture cancel");
    await flush();
    const actualState = new URL(open.mock.calls[0][0]).searchParams.get("state");
    receive({ method: "GET", url: `/x/callback?state=${actualState}&code=fixture-code` }, response());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error("fixture cancel"));
    await rejected;
    expect(secrets.setConnectorSecret).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

});
