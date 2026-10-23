import { describe, expect, it, vi } from "vitest";
import { ArticleReader } from "../src/main/article-reader";
import { HttpStatusError, NetworkRequestError, type PublicHttpClient } from "../src/main/http";
import { RenderedPageHttpError } from "../src/main/rendered-document";
import { RobotsDisallowedError, RobotsNetworkUnavailableError, RobotsRateLimitedError } from "../src/main/robots";
import { readerFailureDiagnostic, type ReaderDiagnostic } from "../src/main/reader-diagnostics";
import type { Entry, Source } from "../src/shared/types";

const source: Source = { id: "s", url: "https://example.com/feed", title: "Feed", kind: "rss", status: "active", pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1 };
const entry: Entry = { id: "e", sourceId: "s", title: "Article", url: "https://example.com/post", canonicalUrl: "https://example.com/post", summary: "This is a saved card summary, not the full original article body.", contentHash: "h", read: false, favorite: false, createdAt: 1 };
const feed = (item: string) => ({ url: source.url, status: 200, contentType: "application/rss+xml", text: `<rss version="2.0"><channel><title>Feed</title>${item}</channel></rss>` });

function setup(original: Error, feedResult: Error | ReturnType<typeof feed>) {
  const http = { getText: vi.fn(async (url: string) => {
    if (url === entry.url) throw original;
    if (feedResult instanceof Error) throw feedResult;
    return feedResult;
  }) };
  const renderer = { render: vi.fn(async () => { throw new RenderedPageHttpError(403); }) };
  return { reader: new ArticleReader(http as unknown as PublicHttpClient, renderer), http, renderer };
}

describe("reader fallback diagnostics", () => {
  it("preserves robots and unavailable feed causes without fetching the blocked page", async () => {
    const { reader, renderer } = setup(new RobotsDisallowedError(), new NetworkRequestError(new Error("private URL and credentials")));
    const diagnostics: ReaderDiagnostic[] = [];
    const result = await reader.read(entry, source, { onDiagnostic: d => diagnostics.push(d) });
    expect(result.contentMode).toBe("feed_summary");
    expect(diagnostics).toEqual([{ stage: "static", reason: "robots_disallowed" }, { stage: "feed", reason: "network" }]);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|credentials|https|summary/);
  });

  it.each([
    ["", "feed_entry_missing"],
    [`<item><title>Post</title><link>${entry.url}</link></item>`, "feed_body_missing"]
  ])("distinguishes an absent entry from a missing feed body", async (item, reason) => {
    const { reader } = setup(new HttpStatusError(403), feed(item));
    const diagnostics: ReaderDiagnostic[] = [];
    expect((await reader.read(entry, source, { onDiagnostic: d => diagnostics.push(d) })).contentMode).toBe("feed_summary");
    expect(diagnostics).toEqual([{ stage: "static", reason: "http", status: 403 }, { stage: "render", reason: "http", status: 403 }, { stage: "feed", reason }]);
  });

  it("keeps a usable feed body and its original-page failure separate", async () => {
    const { reader } = setup(new HttpStatusError(404), feed(`<item><title>Post</title><link>${entry.url}</link><description><![CDATA[<p>${"Full subscribed body. ".repeat(20)}</p>]]></description></item>`));
    const diagnostics: ReaderDiagnostic[] = [];
    expect((await reader.read(entry, source, { onDiagnostic: d => diagnostics.push(d) })).contentMode).toBe("feed_body");
    expect(diagnostics).toEqual([{ stage: "static", reason: "http", status: 404 }, { stage: "render", reason: "http", status: 403 }]);
  });

  it("does not change fallback when an optional observer throws", async () => {
    const { reader } = setup(new RobotsDisallowedError(), new NetworkRequestError());
    expect((await reader.read(entry, source, { onDiagnostic: () => { throw new Error("observer"); } })).contentMode).toBe("feed_summary");
  });

  it("does not turn cancellation during feed fallback into a summary or failure diagnostic", async () => {
    const controller = new AbortController();
    const diagnostics: ReaderDiagnostic[] = [];
    const http = { getText: vi.fn(async (url: string) => {
      if (url === entry.url) throw new RobotsDisallowedError();
      controller.abort(new Error("reader closed"));
      throw controller.signal.reason;
    }) };
    const reader = new ArticleReader(http as unknown as PublicHttpClient, { render: vi.fn() });
    await expect(reader.read(entry, source, { signal: controller.signal, onDiagnostic: d => diagnostics.push(d) })).rejects.toThrow("reader closed");
    expect(diagnostics).toEqual([{ stage: "static", reason: "robots_disallowed" }]);
  });

  it("does not infer a remote restriction from arbitrary error text", () => {
    expect(readerFailureDiagnostic("render", new Error("HTTP 403 secret body"))).toEqual({ stage: "render", reason: "unknown" });
    expect(readerFailureDiagnostic("static", new RobotsNetworkUnavailableError()).reason).toBe("robots_unavailable");
    expect(readerFailureDiagnostic("static", new RobotsRateLimitedError()).reason).toBe("robots_unavailable");
  });

  it("records absence of extractable content independently from unknown exceptions", async () => {
    const http = { getText: async () => ({ url: entry.url, contentType: "text/html", text: "<html><body></body></html>" }) };
    const reader = new ArticleReader(http as unknown as PublicHttpClient, { render: async () => ({ url: entry.url, html: "<html><body></body></html>" }) });
    const diagnostics: ReaderDiagnostic[] = [];
    await expect(reader.read(entry, undefined, { onDiagnostic: d => diagnostics.push(d) })).rejects.toThrow("没有提供");
    expect(diagnostics).toEqual([{ stage: "static", reason: "no_content" }, { stage: "render", reason: "no_content" }]);
  });
});
