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
  return { database, account, secrets, connector, context, replace: (value: object) => { raw = JSON.stringify(value); } };
}

const refreshed = () => new Response(JSON.stringify({ access_token: "fixture-new", refresh_token: "fixture-next", expires_in: 3600 }));
const empty = () => new Response(JSON.stringify({ data: [] }));

describe("X account credentials", () => {
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
});
