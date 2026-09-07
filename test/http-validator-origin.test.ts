import { beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { PublicHttpClient } from "../src/main/http";
const a = "https://example.com/feed";
const b = "https://other.example.org/feed";
const etag = '"shared-value"';
const lastModified = "Sun, 01 Feb 2026 00:00:00 GMT";
const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
beforeEach(() => { network.fetch.mockReset(); });

describe("conditional requests belong to a specific response URL", () => {
  it("does not send an initial resource validator to its redirect destination", async () => {
    const seen: Array<[string, Headers]> = [];
    network.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers); seen.push([url, headers]);
      if (url === a) return new Response(null, { status: 302, headers: { location: b } });
      return headers.has("if-none-match") ? new Response(null, { status: 304 }) : new Response("New representation");
    });
    await expect(client().getText(a, { url: a, etag, lastModified })).resolves.toMatchObject({ url: b, status: 200, text: "New representation" });
    expect(seen[0][1].get("if-none-match")).toBe(etag);
    expect(seen[1][1].has("if-none-match")).toBe(false);
    expect(seen[1][1].has("if-modified-since")).toBe(false);
  });

  it("uses a known final URL validator only on the matching redirect hop", async () => {
    const seen: Array<[string, Headers]> = [];
    network.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      seen.push([url, new Headers(init.headers)]);
      return url === a ? new Response(null, { status: 302, headers: { location: b } }) : new Response(null, { status: 304 });
    });
    await expect(client().getText(a, { url: b, etag, lastModified })).resolves.toMatchObject({ url: b, status: 304 });
    expect(seen[0][1].has("if-none-match")).toBe(false);
    expect(seen[0][1].has("if-modified-since")).toBe(false);
    expect(seen[1][1].get("if-none-match")).toBe(etag);
    expect(seen[1][1].get("if-modified-since")).toBe(lastModified);
  });

  it("keeps different paths and query strings separate, but ignores URL fragments", async () => {
    network.fetch.mockResolvedValue(new Response("Fresh"));
    await client().getText(a + "?edition=two", { url: a + "?edition=one", etag });
    expect(new Headers(network.fetch.mock.lastCall![1].headers).has("if-none-match")).toBe(false);
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await client().getText(a + "#current", { url: a + "#previous", etag });
    expect(new Headers(network.fetch.mock.lastCall![1].headers).get("if-none-match")).toBe(etag);
  });

  it("rejects an unsolicited 304 instead of claiming content is unchanged", async () => {
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(client().getText(a)).rejects.toThrow("304");
  });

  it("does not mistake a Location header on 304 for a redirect", async () => {
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 304, headers: { location: b } }));
    await expect(client().getText(a, { url: a, etag })).resolves.toMatchObject({ url: a, status: 304 });
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });
});

it("keeps explicit loopback feeds inside their original boundary while matching a final path", async () => {
  const start = "http://127.0.0.1:1200/feed";
  const final = "http://127.0.0.1:1200/actual";
  const seen: Array<string | null> = [];
  network.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get("if-none-match"));
    return url === start ? new Response(null, { status: 302, headers: { location: final } }) : new Response(null, { status: 304 });
  });
  const robots = { assertAllowed: vi.fn() };
  await expect(new PublicHttpClient(robots as never).getText(start, { url: final, etag }, { allowTrustedLoopbackFeed: true })).resolves.toMatchObject({ url: final, status: 304 });
  expect(seen).toEqual([null, etag]);
  expect(robots.assertAllowed).not.toHaveBeenCalled();
});
