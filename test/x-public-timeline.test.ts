import { describe, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { RobotsDisallowedError } from "../src/main/robots";
import { XConnector } from "../src/main/x";
import { parsePublicXTimeline, xPublicTimelineUrl } from "../src/main/x-public-timeline";

const profileFixture = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      timeline: {
        entries: [
          { type: "tweet", content: { tweet: {
            id_str: "200", full_text: "Original post with https://example.test/read", created_at: "Tue Aug 18 12:00:00 +0000 2026",
            user: { screen_name: "Example_User" },
            entities: { urls: [{ expanded_url: "https://example.test/read" }] },
            extended_entities: { media: [{ media_url_https: "https://pbs.twimg.com/media/clear.jpg" }] }
          } } },
          { type: "tweet", content: { tweet: {
            id_str: "201", full_text: "A reply", in_reply_to_status_id_str: "10", user: { screen_name: "Example_User" }
          } } },
          { type: "tweet", content: { tweet: {
            id_str: "202", full_text: "A repost", retweeted_status: { id_str: "9" }, user: { screen_name: "Example_User" }
          } } },
          { type: "tweet", content: { tweet: {
            id_str: "203", full_text: "Quoted account", user: { screen_name: "Other" }
          } } }
        ]
      }
    }
  }
})}</script>`;

describe("X public embed timeline", () => {
  it("builds a privacy-preserving public embed URL", () => {
    const url = new URL(xPublicTimelineUrl("Example_User"));
    expect(url.origin).toBe("https://syndication.twitter.com");
    expect(url.pathname).toBe("/srv/timeline-profile/screen-name/Example_User");
    expect(url.searchParams.get("dnt")).toBe("true");
    expect(url.searchParams.get("showReplies")).toBe("false");
  });

  it("parses the server-rendered public embed JSON without executing scripts", () => {
    const timeline = parsePublicXTimeline(profileFixture, "example_user");
    expect(timeline.recognized).toBe(true);
    expect(timeline.entries).toMatchObject([{
      externalId: "200",
      url: "https://x.com/Example_User/status/200",
      title: "Original post with https://example.test/read",
      publishedAt: Date.parse("2026-08-18T12:00:00Z"),
      imageUrl: "https://pbs.twimg.com/media/clear.jpg",
      externalUrl: "https://example.test/read"
    }]);
    expect(timeline.entries).toHaveLength(1);
  });

  it("ignores executable-looking scripts and accepts the newer Tweet legacy envelope", () => {
    const html = `<script>globalThis.__xEmbedMustNotRun = true</script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { timeline: { entries: [{ itemContent: { tweet_results: { result: {
        __typename: "Tweet", rest_id: "300", legacy: {
          full_text: "New payload", created_at: "2026-08-19T00:00:00Z", entities: { urls: [] }
        }, core: { user_results: { result: { legacy: { screen_name: "example" } } } }
      } } } }] } } }
    })}</script>`;
    const timeline = parsePublicXTimeline(html, "example");
    expect((globalThis as Record<string, unknown>).__xEmbedMustNotRun).toBeUndefined();
    expect(timeline.entries).toMatchObject([{ externalId: "300", url: "https://x.com/example/status/300", title: "New payload" }]);
  });

  it("never calls X API or reads a Keychain account for a public profile", async () => {
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({
      url: "https://x.com/Example_User", title: "Example", kind: "x", connectorId: "x",
      config: { mode: "public-profile", username: "Example_User", transport: "x-public-embed" }, pollingEnabled: true
    });
    const apiFetch = vi.fn();
    const publicHttp = { getText: vi.fn(async () => ({
      url: xPublicTimelineUrl("Example_User"), status: 200, contentType: "text/html", text: profileFixture, etag: "embed-v1", lastModified: "Tue, 18 Aug 2026 12:00:00 GMT"
    })) };
    const connector = new XConnector(database, { getConnectorSecret: vi.fn() } as any, async () => undefined, apiFetch, publicHttp as any);
    const result = await connector.sync({ source, subscription: database.getSubscriptionForSource(source.id)! });
    expect(result.entries).toHaveLength(1);
    expect(result.checkpoint).toMatchObject({ sinceId: "200", data: { transport: "x-public-embed" } });
    expect(publicHttp.getText).toHaveBeenCalledOnce();
    expect(apiFetch).not.toHaveBeenCalled();
    database.close();
  });

  it("reports a clear rate-limit message instead of falling back to a private web API", async () => {
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({
      url: "https://x.com/example", title: "Example", kind: "x", connectorId: "x",
      config: { mode: "public-profile", username: "example" }, pollingEnabled: true
    });
    const connector = new XConnector(database, {} as any, async () => undefined, vi.fn(), {
      getText: async () => { throw new Error("请求失败（HTTP 429）"); }
    } as any);
    await expect(connector.sync({ source, subscription: database.getSubscriptionForSource(source.id)! })).rejects.toThrow("公开嵌入时间线暂时限流（HTTP 429）");
    database.close();
  });

  it("explains an explicit robots restriction without suggesting a bypass", async () => {
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({
      url: "https://x.com/example", title: "Example", kind: "x", connectorId: "x",
      config: { mode: "public-profile", username: "example" }, pollingEnabled: true
    });
    const connector = new XConnector(database, {} as any, async () => undefined, vi.fn(), {
      getText: async () => { throw new RobotsDisallowedError(); }
    } as any);
    await expect(connector.sync({ source, subscription: database.getSubscriptionForSource(source.id)! })).rejects.toThrow("robots.txt 明确禁止自动读取");
    database.close();
  });
});
