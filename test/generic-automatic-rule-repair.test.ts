import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { GenericConnector } from "../src/main/connectors";
import { contentNormalizer } from "../src/main/content-normalizer";
import { ReadingDatabase } from "../src/main/database";
import { AUTOMATIC_RULE_REVISION, PUBLICATION_DATE_REVISION } from "../src/main/extractor";
import { FEED_DISCOVERY_REVISION } from "../src/main/feed";
import { SyncManager } from "../src/main/sync-manager";

const sourceUrl = "https://blog.recsys-frontier.example/";
const firstUrl = "https://blog.recsys-frontier.example/article/first";
const secondUrl = "https://blog.recsys-frontier.example/article/second";
const historicalUrl = "https://blog.recsys-frontier.example/article/historical-only";
// The affected source was saved at this automatic-rule revision.  Keep this
// explicit so a future implementation cannot accidentally pass by treating a
// merely hypothetical stale rule as the regression case.
const LEGACY_CTA_RULE_REVISION = 7;

/**
 * The visible cards deliberately have the same shape as the broken source:
 * one long title anchor and one short CTA point at each article.  The history
 * link is in page chrome and must never turn a normal current-page refresh
 * into an archive import.
 */
const page = `<!doctype html><html><head><title>Recsys Frontier</title></head><body>
  <main>
    <div class="w-full"><section class="shadow">
      <h2><a href="/article/first">A first recommendation systems article with a real title</a></h2>
      <time datetime="2026-09-11">2026-09-11</time>
      <p>A substantial first card summary that belongs to the real article, not its action button.</p>
      <img src="/images/first.png" alt="First chart">
      <a class="details" href="/article/first">文章详情</a>
    </section></div>
    <div class="w-full"><section class="shadow">
      <h2><a href="/article/second">A second recommendation systems article with a real title</a></h2>
      <time datetime="2026-09-12">2026-09-12</time>
      <p>A substantial second card summary that belongs to the real article, not its action button.</p>
      <img src="/images/second.png" alt="Second chart">
      <a class="details" href="/article/second">文章详情</a>
    </section></div>
  </main>
  <nav class="pagination"><a href="/article/historical-only">A historical article that is not in the current card list</a></nav>
  <script id="__NEXT_DATA__" type="application/json">{"allPosts":["${historicalUrl}"]}</script>
</body></html>`;

describe("automatic generic-rule repair", () => {
  it("replays a stale CTA-link rule into existing cards without importing history or losing state", async () => {
    expect(AUTOMATIC_RULE_REVISION).toBeGreaterThan(LEGACY_CTA_RULE_REVISION);
    const database = new ReadingDatabase(":memory:");
    const source = database.createSource({
      url: sourceUrl,
      title: "Recsys Frontier",
      kind: "generic",
      pollingEnabled: true,
      extractionRule: {
        version: 1,
        selection: "automatic",
        // A revision bump makes a regular refresh replay this stale rule once.
        autoRepairRevision: LEGACY_CTA_RULE_REVISION,
        publicationDateRevision: PUBLICATION_DATE_REVISION,
        feedDiscoveryRevision: FEED_DISCOVERY_REVISION,
        itemRootSelector: 'a[href*="/article/"]'
      }
    });
    const oldFirst = contentNormalizer.normalize({ url: firstUrl, title: "文章详情" }, source);
    const oldSecond = contentNormalizer.normalize({ url: secondUrl, title: "文章详情" }, source);
    database.saveEntries([oldFirst, oldSecond]);
    database.markRead(oldFirst.id, true);
    database.markFavorite(oldSecond.id, true);
    database.markSuccess(source, { etag: '"old-page"', validatorUrl: sourceUrl });
    const beforeFirst = database.getEntry(oldFirst.id)!;
    const beforeSecond = database.getEntry(oldSecond.id)!;

    const requests: unknown[] = [];
    const http = {
      getText: async (url: string, cached?: unknown) => {
        requests.push(cached);
        return { url, status: 200, contentType: "text/html", text: page, etag: '"current-page"' };
      }
    };
    const registry = new ConnectorRegistry();
    registry.register(new GenericConnector(http as never));
    const sync = new SyncManager(database, registry);

    try {
      const result = await sync.syncSource(source.id);
      const first = database.getEntry(oldFirst.id)!;
      const second = database.getEntry(oldSecond.id)!;

      // The revision gate turns this into one ordinary uncached refresh even
      // though the source previously had an ETag.
      expect(requests).toEqual([undefined]);
      expect(result.inserted).toBe(0);
      expect(result.source.extractionRule).toMatchObject({
        selection: "automatic",
        autoRepairRevision: AUTOMATIC_RULE_REVISION
      });
      expect(result.source.extractionRule?.itemRootSelector).not.toBe('a[href*="/article/"]');

      expect(first).toMatchObject({
        id: oldFirst.id,
        canonicalUrl: firstUrl,
        title: "A first recommendation systems article with a real title",
        publishedAt: Date.UTC(2026, 8, 11),
        summary: "A substantial first card summary that belongs to the real article, not its action button.",
        imageUrl: "https://blog.recsys-frontier.example/images/first.png",
        read: true,
        favorite: false,
        createdAt: beforeFirst.createdAt
      });
      expect(second).toMatchObject({
        id: oldSecond.id,
        canonicalUrl: secondUrl,
        title: "A second recommendation systems article with a real title",
        publishedAt: Date.UTC(2026, 8, 12),
        summary: "A substantial second card summary that belongs to the real article, not its action button.",
        imageUrl: "https://blog.recsys-frontier.example/images/second.png",
        read: false,
        favorite: true,
        createdAt: beforeSecond.createdAt
      });
      expect(database.listEntries({ sourceId: source.id }).map((entry) => entry.canonicalUrl).sort()).toEqual([firstUrl, secondUrl]);
      expect(database.listEntries({ sourceId: source.id }).some((entry) => entry.canonicalUrl === historicalUrl)).toBe(false);
    } finally {
      await sync.close();
      database.close();
    }
  });
});
