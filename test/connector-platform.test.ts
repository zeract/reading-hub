import { afterEach, describe, expect, it, vi } from "vitest";
import { AcademicAuthorConnector } from "../src/main/academic";
import { builtInManifest, ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { XConnector } from "../src/main/x";
import type { Source } from "../src/shared/types";

const academicSource: Source = {
  id: "academic-source", url: "https://academic.local/author/test", title: "Researcher", kind: "academic", connectorId: "academic",
  status: "active", pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1
};

describe("connector platform", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("only accepts explicitly built-in adapters", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.register({
      manifest: { ...builtInManifest("academic", "Test", [], []), builtIn: false },
      sync: async () => ({ entries: [] }),
      normalize: () => { throw new Error("unused"); }
    } as any)).toThrow("只允许注册内置连接器");
  });

  it("normalizes academic DOI records to stable cross-provider content identity", () => {
    const connector = new AcademicAuthorConnector();
    const entry = connector.normalize({
      url: "https://doi.org/10.1000/example",
      title: "Paper",
      canonicalIdentity: "doi:10.1000/example",
      externalId: "openalex:work",
      providerId: "academic",
      providerLabel: "OpenAlex"
    }, academicSource);
    expect(entry).toMatchObject({
      canonicalUrl: "https://doi.org/10.1000/example",
      canonicalIdentity: "doi:10.1000/example",
      providerLabel: "OpenAlex",
      providerId: "academic"
    });
  });

  it("keeps X status URLs as the reader target and stores a provider identity", () => {
    const connector = new XConnector({} as any, {} as any, async () => undefined);
    const entry = connector.normalize({
      url: "https://x.com/example/status/42",
      title: "A post",
      externalId: "42",
      canonicalIdentity: "x:42",
      providerId: "x"
    }, { ...academicSource, id: "x-source", kind: "x", connectorId: "x" });
    expect(entry).toMatchObject({ canonicalUrl: "https://x.com/example/status/42", canonicalIdentity: "x:42", providerId: "x", providerLabel: "X" });
  });

  it("syncs followed users incrementally while excluding replies and reposts", async () => {
    const database = new ReadingDatabase(":memory:");
    const account = database.saveAccount({
      connectorId: "x", displayName: "X", subjectId: "owner", keychainAccount: "x:account", scopes: ["tweet.read"], status: "active", config: { clientId: "client" }
    });
    const source = database.createSource({ url: "https://api.x.com/2/users/owner/following", title: "X", kind: "x", connectorId: "x", accountId: account.id, pollingEnabled: true });
    const secretStore = { getConnectorSecret: async () => JSON.stringify({ accessToken: "local-only", expiresAt: Date.now() + 3_600_000 }) };
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("/following")) return new Response(JSON.stringify({ data: [{ id: "followed", name: "Followed", username: "followed" }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [
        { id: "100", text: "An original post", created_at: "2026-08-15T00:00:00Z" },
        { id: "101", text: "A reply", in_reply_to_user_id: "other" },
        { id: "102", text: "A repost", referenced_tweets: [{ type: "retweeted", id: "10" }] }
      ] }), { status: 200 });
    });
    const connector = new XConnector(database, secretStore as any, async () => undefined, fetchMock);
    const subscription = database.getSubscriptionForSource(source.id)!;
    const result = await connector.sync({ source, subscription, account });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ externalId: "100", providerLabel: "X", url: "https://x.com/followed/status/100" });
    expect(result.checkpoint?.data).toMatchObject({ sinceByUser: { followed: "102" } });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining("https://api.x.com/2/users/owner/following"),
      expect.stringContaining("https://api.x.com/2/users/followed/tweets")
    ]));
    database.close();
  });

  it("reports a safe, actionable error when the X token service cannot be reached", async () => {
    const connector = new XConnector({} as any, {} as any, async () => undefined, async () => {
      throw new TypeError("fetch failed with request credentials");
    });
    await expect((connector as any).exchangeToken(new URLSearchParams({ grant_type: "authorization_code" }))).rejects.toMatchObject({
      name: "XApiError",
      message: "无法连接到 X OAuth 令牌服务。请检查系统代理、VPN、DNS 或网络访问后重试。"
    });
  });

  it("explains that a 402 response requires X API billing access without exposing the token", async () => {
    const connector = new XConnector({} as any, {} as any, async () => undefined, async () => new Response("{}", { status: 402 }));
    await expect((connector as any).requestJson("/users/me", "user-token-must-not-appear")).rejects.toMatchObject({
      name: "XApiError",
      message: "读取当前 X 账号需要 X API 的可用计费访问（HTTP 402）。请在 X Developer Console 的 Billing / Usage 中为该项目启用 API 额度后重新连接。"
    });
  });

  it("queries academic providers through their documented API roots", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.includes("api.openalex.org")) return new Response(JSON.stringify({ results: [{ id: "https://openalex.org/W1", doi: "https://doi.org/10.1000/example", title: "OpenAlex paper", publication_date: "2026-08-15" }] }), { status: 200 });
      if (url.includes("semanticscholar")) return new Response(JSON.stringify({ data: [{ paperId: "S1", title: "Semantic paper", publicationDate: "2026-08-14", externalIds: { DOI: "10.1000/example" } }] }), { status: 200 });
      return new Response(JSON.stringify({ group: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = new AcademicAuthorConnector();
    const result = await connector.sync({
      source: academicSource,
      subscription: {
        id: "subscription", sourceId: academicSource.id, connectorId: "academic", config: {
          authorName: "Researcher", openAlexId: "A1", semanticScholarId: "S1", orcid: "0000-0000-0000-0000"
        }, createdAt: 1, updatedAt: 1
      }
    });
    expect(result.entries).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining("https://api.openalex.org/works"),
      expect.stringContaining("https://api.semanticscholar.org/graph/v1/author/S1/papers"),
      expect.stringContaining("https://pub.orcid.org/v3.0/0000-0000-0000-0000/works")
    ]));
  });
});
