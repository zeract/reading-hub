import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { XConnector } from "../src/main/x";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const database = new ReadingDatabase(":memory:");
  const account = database.saveAccount({ connectorId: "x", displayName: "X", subjectId: "owner", keychainAccount: "x:fixture", scopes: [], status: "active", config: { clientId: "fixture-client" } });
  const source = database.createSource({ url: "https://api.x.com/2/users/owner/following", title: "X", kind: "x", accountId: account.id, pollingEnabled: true });
  let raw = JSON.stringify({ accessToken: "fixture-old", refreshToken: "fixture-refresh", expiresAt: 1 });
  const secrets = {
    getConnectorSecret: vi.fn(async () => raw),
    setConnectorSecret: vi.fn(async (_connector: string, _id: string, value: string) => { raw = value; return "x:fixture"; })
  };
  const connector = new XConnector(database, secrets, async () => undefined, fetcher);
  const context = { source, subscription: database.getSubscriptionForSource(source.id)!, account };
  return { database, account, secrets, connector, context, replace: (value: unknown) => { raw = JSON.stringify(value); } };
}

const refreshed = () => new Response(JSON.stringify({ access_token: "fixture-new", refresh_token: "fixture-next", expires_in: 3600 }));
const empty = () => new Response(JSON.stringify({ data: [] }));

describe("X account credentials", () => {
  it("retains refresh credentials after an unsafe token redirect and recovers on the next attempt", async () => {
    let blocked = true;
    const fetcher = vi.fn(async (url: string) => url.endsWith("/oauth2/token")
      ? blocked ? new Response(null, { status: 307, headers: { location: "https://other.example/fixture-private-marker" } }) : refreshed()
      : empty());
    const f = fixture(fetcher);
    try {
      await expect(f.connector.sync(f.context)).rejects.toThrow("允许范围");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith("https://api.x.com/2/oauth2/token", expect.objectContaining({ redirect: "manual" }));
      expect(f.secrets.setConnectorSecret).not.toHaveBeenCalled();
      expect(JSON.parse((await f.secrets.getConnectorSecret())!)).toMatchObject({ refreshToken: "fixture-refresh" });
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
      expect(JSON.stringify(f.database.listSyncEvents())).not.toMatch(/fixture-private-marker|fixture-refresh/);
      blocked = false;
      await expect(f.connector.sync(f.context)).resolves.toMatchObject({ entries: [] });
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("refreshes a shared account once when two subscriptions sync concurrently", async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) { started.resolve(); return (await response.promise).clone(); }
      return empty();
    });
    const f = fixture(fetcher);
    try {
      const first = f.connector.sync(f.context);
      const second = f.connector.sync(f.context);
      await started.promise;
      response.resolve(refreshed());
      await Promise.all([first, second]);
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/oauth2/token"))).toHaveLength(1);
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("does not expire replacement credentials when an old API request returns 401", async () => {
    const oldRequest = deferred<Response>();
    const started = deferred<void>();
    const f = fixture(async () => { started.resolve(); return oldRequest.promise; });
    try {
      f.replace({ accessToken: "fixture-old", expiresAt: Date.now() + 3_600_000 });
      const pending = f.connector.sync(f.context);
      await started.promise;
      f.replace({ accessToken: "fixture-new", expiresAt: Date.now() + 3_600_000 });
      oldRequest.resolve(new Response("{}", { status: 401 }));
      await expect(pending).rejects.toThrow();
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
    } finally { f.database.close(); }
  });

  it("cancels a queued subscriber promptly without letting a later subscriber overtake the refresh", async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth2/token")) { started.resolve(); return (await response.promise).clone(); }
      return empty();
    });
    const f = fixture(fetcher);
    try {
      const first = f.connector.sync(f.context);
      await started.promise;
      const controller = new AbortController();
      const cancelled = f.connector.sync({ ...f.context, signal: controller.signal });
      controller.abort(new Error("cancel queued"));
      await expect(cancelled).rejects.toThrow("cancel queued");
      const last = f.connector.sync(f.context);
      expect(f.secrets.getConnectorSecret).toHaveBeenCalledTimes(1);
      response.resolve(refreshed());
      await Promise.all([first, last]);
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/oauth2/token"))).toHaveLength(1);
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
    } finally { f.database.close(); }
  });

  it("releases an aborted refresh so another subscriber can retry", async () => {
    const started = deferred<void>();
    let requests = 0;
    let requestSignal: AbortSignal | null | undefined;
    const f = fixture(async (url, init) => {
      if (!url.endsWith("/oauth2/token")) return empty();
      if (++requests > 1) return refreshed();
      requestSignal = init?.signal;
      started.resolve();
      return new Promise<Response>(() => undefined);
    });
    try {
      const controller = new AbortController();
      const first = f.connector.sync({ ...f.context, signal: controller.signal });
      await started.promise;
      const next = f.connector.sync(f.context);
      controller.abort(new Error("cancel refresh"));
      await expect(first).rejects.toThrow("cancel refresh");
      await next;
      expect(requestSignal?.aborted).toBe(true);
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
    } finally { f.database.close(); }
  });

  it("does not retain a failed credential turn or expire an account on a temporary failure", async () => {
    let requests = 0;
    const f = fixture(async (url) => url.endsWith("/oauth2/token")
      ? ++requests === 1 ? new Response("{}", { status: 503 }) : refreshed()
      : empty());
    try {
      await expect(f.connector.sync(f.context)).rejects.toThrow("503");
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
      await expect(f.connector.sync(f.context)).resolves.toMatchObject({ entries: [] });
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it.each([400, 401])("still marks rejected refresh credentials expired on HTTP %s", async (status) => {
    const f = fixture(async () => new Response("{}", { status }));
    try {
      await expect(f.connector.sync(f.context)).rejects.toThrow();
      expect(f.database.getAccount(f.account.id)?.status).toBe("expired");
      expect(f.secrets.setConnectorSecret).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("finishes a Keychain write before releasing a cancelled refresh to the next subscriber", async () => {
    const writing = deferred<void>();
    const releaseWrite = deferred<void>();
    const fetcher = vi.fn(async (url: string) => url.endsWith("/oauth2/token") ? refreshed() : empty());
    const f = fixture(fetcher);
    const save = f.secrets.setConnectorSecret.getMockImplementation()!;
    f.secrets.setConnectorSecret.mockImplementation(async (...args) => {
      writing.resolve();
      await releaseWrite.promise;
      return save(...args);
    });
    try {
      const controller = new AbortController();
      const first = f.connector.sync({ ...f.context, signal: controller.signal });
      await writing.promise;
      controller.abort(new Error("cancel while saving"));
      const second = f.connector.sync(f.context);
      releaseWrite.resolve();
      await expect(first).rejects.toThrow("cancel while saving");
      await second;
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/oauth2/token"))).toHaveLength(1);
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
    } finally { f.database.close(); }
  });

  it("uses the current account configuration instead of saving a stale sync snapshot", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/oauth2/token") ? refreshed() : empty());
    const f = fixture(fetcher);
    try {
      f.database.saveAccount({ ...f.account, displayName: "Updated", config: { clientId: "fixture-updated-client" } });
      await f.connector.sync(f.context);
      const init = fetcher.mock.calls.find(([url]) => url.endsWith("/oauth2/token"))![1];
      expect((init?.body as URLSearchParams).get("client_id")).toBe("fixture-updated-client");
      expect(f.database.getAccount(f.account.id)?.displayName).toBe("Updated");
    } finally { f.database.close(); }
  });

  it("commits new authorization after an in-flight refresh, so the old refresh cannot overwrite it", async () => {
    const response = deferred<Response>();
    const refreshStarted = deferred<void>();
    const authorizationChecked = deferred<void>();
    const f = fixture(async (url, init) => {
      if (url.endsWith("/oauth2/token")) { refreshStarted.resolve(); return response.promise; }
      if (url.endsWith("/users/me")) return new Response(JSON.stringify({ data: { id: "owner", username: "new-name" } }));
      if (new Headers(init?.headers).get("authorization") === "Bearer fixture-authorized") authorizationChecked.resolve();
      return empty();
    });
    try {
      const oauth = f.connector as unknown as {
        waitForAuthorizationCode: () => Promise<string>;
        exchangeAuthorizationCode: () => Promise<{ accessToken: string }>;
      };
      vi.spyOn(oauth, "waitForAuthorizationCode").mockResolvedValue("fixture-code");
      vi.spyOn(oauth, "exchangeAuthorizationCode").mockResolvedValue({ accessToken: "fixture-authorized" });
      const syncing = f.connector.sync(f.context);
      await refreshStarted.promise;
      const authorizing = f.connector.authorizeWithClientId("fixture-new-client");
      await authorizationChecked.promise;
      response.resolve(refreshed());
      await Promise.all([syncing, authorizing]);
      expect(JSON.parse((await f.secrets.getConnectorSecret())!)).toEqual({ accessToken: "fixture-authorized" });
      expect(f.database.getAccount(f.account.id)).toMatchObject({ displayName: "X · @new-name", config: { clientId: "fixture-new-client" }, status: "active" });
    } finally { f.database.close(); }
  });

  it.each([
    { access_token: 123, refresh_token: "fixture-next", expires_in: 3600 },
    { access_token: "fixture-new", refresh_token: {}, expires_in: 3600 },
    { access_token: "fixture-new", expires_in: -1 },
    { access_token: "fixture-new", expires_in: "3600" },
    null, [], {}, { access_token: "fixture-new", expires_in: null },
    { access_token: "fixture-new", expires_in: Number.MAX_SAFE_INTEGER },
    { access_token: "fixture-new", expires_in: 1.5 },
    { access_token: "fixture-new", refresh_token: null },
    { access_token: "fixture-new", token_type: "unexpected" },
    { access_token: "fixture-new", error: "fixture-private-details" },
    { access_token: "fixture-token with whitespace" }
  ])("does not overwrite usable refresh credentials with malformed HTTP 200 data: %j", async (payload) => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/oauth2/token") ? new Response(JSON.stringify(payload)) : empty());
    const f = fixture(fetcher);
    try {
      const before = await f.secrets.getConnectorSecret();
      await expect(f.connector.sync(f.context)).rejects.toThrow("令牌响应无效");
      expect(f.secrets.setConnectorSecret).not.toHaveBeenCalled();
      expect(await f.secrets.getConnectorSecret()).toBe(before);
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("retains the current refresh token when a successful refresh does not rotate it", async () => {
    const f = fixture(async (url) => url.endsWith("/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "fixture-new", expires_in: 3600 })) : empty());
    try {
      await f.connector.sync(f.context);
      expect(JSON.parse((await f.secrets.getConnectorSecret())!)).toMatchObject({ accessToken: "fixture-new", refreshToken: "fixture-refresh" });
    } finally { f.database.close(); }
  });

  it("treats an explicit zero expiry as expired instead of an unlimited token", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/oauth2/token") ? refreshed() : empty());
    const f = fixture(fetcher);
    f.replace({ accessToken: "fixture-old", refreshToken: "fixture-refresh", expiresAt: 0 });
    try {
      await f.connector.sync(f.context);
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).toContain("/oauth2/token");
    } finally { f.database.close(); }
  });


  it.each([
    null, [], "fixture-private-details", {}, { accessToken: 123 },
    { accessToken: "fixture-old", refreshToken: {} }, { accessToken: "fixture-old", expiresAt: "invalid" },
    { accessToken: "fixture-old", expiresAt: null }, { accessToken: "fixture-old", expiresAt: -1 },
    { accessToken: "fixture-token with whitespace" }
  ])("rejects malformed stored credentials before any network request: %j", async (stored) => {
    const fetcher = vi.fn(async () => empty());
    const f = fixture(fetcher);
    f.replace(stored);
    try {
      const before = await f.secrets.getConnectorSecret();
      const error = await f.connector.sync(f.context).catch((failure) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("X 本地授权信息无法读取，请重新连接 X。");
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain("fixture-private-details");
      expect(f.database.getAccount(f.account.id)?.status).toBe("error");
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.secrets.setConnectorSecret).not.toHaveBeenCalled();
      expect(await f.secrets.getConnectorSecret()).toBe(before);
    } finally { f.database.close(); }
  });

  it("stores a zero lifetime as an explicit deadline", async () => {
    const f = fixture(async (url) => url.endsWith("/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "fixture-new", token_type: "Bearer", expires_in: 0 })) : empty());
    try {
      const started = Date.now();
      await f.connector.sync(f.context);
      const stored = JSON.parse((await f.secrets.getConnectorSecret())!);
      expect(stored.expiresAt).toBeGreaterThanOrEqual(started);
      expect(stored.expiresAt).toBeLessThanOrEqual(Date.now());
      expect(stored.refreshToken).toBe("fixture-refresh");
    } finally { f.database.close(); }
  });

  it("reuses a retained refresh token after connector restart and replaces it only on rotation", async () => {
    let refreshes = 0;
    const fetcher = async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/oauth2/token")) return empty();
      expect((init?.body as URLSearchParams).get("refresh_token")).toBe("fixture-refresh");
      refreshes += 1;
      return refreshes === 1 ? new Response(JSON.stringify({ access_token: "fixture-first", expires_in: 3600 })) : refreshed();
    };
    const f = fixture(fetcher);
    try {
      await f.connector.sync(f.context);
      f.replace({ ...JSON.parse((await f.secrets.getConnectorSecret())!), expiresAt: 0 });
      const restarted = new XConnector(f.database, f.secrets, async () => undefined, fetcher);
      await restarted.sync(f.context);
      expect(refreshes).toBe(2);
      expect(JSON.parse((await f.secrets.getConnectorSecret())!)).toMatchObject({ accessToken: "fixture-new", refreshToken: "fixture-next" });
    } finally { f.database.close(); }
  });

  it("recovers after a malformed token response without persisting remote diagnostic fields", async () => {
    let requests = 0;
    const f = fixture(async (url) => url.endsWith("/oauth2/token")
      ? ++requests === 1 ? new Response(JSON.stringify({ access_token: { detail: "fixture-private-details" } })) : refreshed()
      : empty());
    try {
      const error = await f.connector.sync(f.context).catch((failure) => failure);
      expect(error.message).toContain("令牌响应无效");
      expect(error.message).not.toContain("fixture-private-details");
      expect(error.cause).toBeUndefined();
      expect(error.status).toBeUndefined();
      await f.connector.sync(f.context);
      expect(f.secrets.setConnectorSecret).toHaveBeenCalledTimes(1);
      expect(f.database.getAccount(f.account.id)?.status).toBe("active");
    } finally { f.database.close(); }
  });

});
