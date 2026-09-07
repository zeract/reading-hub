import { afterEach, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("../src/main/network", () => ({ chromiumFetch: fetcher }));
import { PublicHttpClient } from "../src/main/http";
import { ArticleReader } from "../src/main/article-reader";
import type { RobotsPolicy } from "../src/main/robots";
import type { Entry } from "../src/shared/types";

const entry: Entry = { id: "fixture", sourceId: "fixture", url: "https://doi.org/fixture", canonicalUrl: "https://doi.org/fixture", title: "Fixture article", contentHash: "fixture", createdAt: 1, read: false, favorite: false };
const html = `<article><h1>Fixture article</h1><p>${"Publisher article prose. ".repeat(35)}</p></article>`;
const metadata = JSON.stringify({ title: "Fixture article", reference: Array.from({ length: 40 }, () => ({ text: "Metadata citation, not article prose", escaped: "\\u2014" })) });
const client = () => new PublicHttpClient({ assertAllowed: vi.fn(async () => undefined) } as unknown as RobotsPolicy);
afterEach(() => fetcher.mockReset());

it("negotiates original HTML across DOI redirects instead of JSON metadata", async () => {
  fetcher.mockImplementation(async (url: string, init: RequestInit) => {
    if (new Headers(init.headers).get("accept")?.includes("application/json")) return new Response(metadata, { headers: { "content-type": "application/json" } });
    return url.startsWith("https://doi.org/")
      ? new Response(null, { status: 302, headers: { location: "https://publisher.example/article" } })
      : new Response(html, { headers: { "content-type": "text/html" } });
  });
  const render = vi.fn(async () => "");
  const article = await new ArticleReader(client(), { render }).read(entry);
  expect(article.contentHtml).toContain("Publisher article prose");
  expect(article.contentHtml).not.toContain("Metadata citation");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(render).not.toHaveBeenCalled();
});

it.each([true, false])("rejects declared JSON as original text (browser HTML available: %s)", async (available) => {
  fetcher.mockResolvedValue(new Response(metadata, { headers: { "content-type": "application/json; charset=utf-8" } }));
  const render = vi.fn(async () => available ? html : "");
  const pending = new ArticleReader(client(), { render }).read(entry);
  if (available) expect((await pending).contentHtml).toContain("Publisher article prose");
  else await expect(pending).rejects.toThrow();
  expect(render).toHaveBeenCalledTimes(1);
});

it("retains feed negotiation for subscription reads", async () => {
  fetcher.mockResolvedValue(new Response('{"version":"https://jsonfeed.org/version/1","items":[]}', { headers: { "content-type": "application/feed+json" } }));
  const response = await client().getText("https://example.com/feed");
  expect(response.contentType).toBe("application/feed+json");
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("accept")).toContain("application/json");
});
