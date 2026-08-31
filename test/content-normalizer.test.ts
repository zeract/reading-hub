import { describe, expect, it } from "vitest";
import { contentHash, identityContentHash } from "../src/main/content-hash";
import { contentNormalizer } from "../src/main/content-normalizer";
import { MAX_FUTURE_PUBLICATION_SKEW_MS } from "../src/shared/publication-date";
import type { Source } from "../src/shared/types";

const source: Source = {
  id: "source",
  url: "https://example.com/",
  title: "Example",
  kind: "generic",
  connectorId: "generic",
  status: "active",
  pollingEnabled: true,
  consecutiveEmpty: 0,
  failureCount: 0,
  createdAt: 1,
  updatedAt: 1
};

describe("ContentNormalizer", () => {
  it("owns generic canonical URL, provenance, metadata hash, and transient entry fields", () => {
    const raw = {
      url: "https://Example.com/post/?utm_source=feed#section",
      title: "A post",
      summary: "A summary",
      publishedAt: 123,
      observedAt: 456,
      externalUrl: "https://example.com/external",
      feedContentHtml: "<p>Transient feed body</p>"
    };

    const entry = contentNormalizer.normalize(raw, source);

    expect(entry).toMatchObject({
      sourceId: source.id,
      canonicalUrl: "https://example.com/post",
      canonicalIdentity: "https://example.com/post",
      providerId: "generic",
      observedAt: 456,
      read: false,
      favorite: false,
      externalUrl: raw.externalUrl,
      feedContentHtml: raw.feedContentHtml
    });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.contentHash).toBe(contentHash(raw));
  });

  it("allows providers to keep stable external identities in reader URLs and hashes", () => {
    const raw = {
      url: "https://provider.example/posts/42?delivery=latest",
      title: "Same title",
      summary: "Same summary",
      externalId: "42"
    };
    const identity = "provider:42";
    const entry = contentNormalizer.normalize(raw, source, {
      canonicalizeUrl: (url) => url,
      canonicalIdentity: (item) => `provider:${item.externalId}`,
      canonicalUrl: (item, resolvedIdentity) => `https://reader.example/${resolvedIdentity}/${item.externalId}`,
      hashMode: "identity",
      providerId: "x",
      providerLabel: "Provider"
    });

    expect(entry).toMatchObject({
      canonicalUrl: "https://reader.example/provider:42/42",
      canonicalIdentity: identity,
      providerId: "x",
      providerLabel: "Provider"
    });
    expect(entry.contentHash).toBe(identityContentHash(identity, raw));
  });

  it("keeps a far-future provider date out of the published timeline", () => {
    const raw = {
      url: "https://example.com/future-post",
      title: "Incorrectly future-dated post",
      summary: "The card remains available using its collection time.",
      publishedAt: Date.now() + MAX_FUTURE_PUBLICATION_SKEW_MS + 60_000,
      observedAt: 456
    };

    const entry = contentNormalizer.normalize(raw, source);

    expect(entry).toMatchObject({ publishedAt: undefined, observedAt: 456 });
    expect(entry.contentHash).toBe(contentHash({ ...raw, publishedAt: undefined }));
  });

  it("retains a publication date within the timezone and clock-skew allowance", () => {
    const publishedAt = Date.now() + 60 * 60_000;
    const entry = contentNormalizer.normalize({
      url: "https://example.com/near-future-post",
      title: "A date within the allowance",
      publishedAt
    }, source);

    expect(entry.publishedAt).toBe(publishedAt);
  });
});
