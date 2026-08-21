import { describe, expect, it } from "vitest";
import { sourceFaviconCandidate, sourceIconKind } from "../src/shared/source-icon";
import type { Source } from "../src/shared/types";

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "source-1",
    url: "https://example.com/feed.xml",
    title: "Example",
    kind: "rss",
    status: "active",
    pollingEnabled: true,
    consecutiveEmpty: 0,
    failureCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe("source icons", () => {
  it("uses a verified Feed-declared image before a same-site favicon", () => {
    expect(sourceFaviconCandidate(source({ iconUrl: "https://cdn.example.com/logo.png" }))).toBe("https://cdn.example.com/logo.png");
    expect(sourceFaviconCandidate(source())).toBe("https://example.com/favicon.ico");
  });

  it("uses local branded fallbacks for platform and manual sources", () => {
    expect(sourceIconKind(source({ kind: "zhihu_follow", url: "https://www.zhihu.com/follow" }))).toBe("zhihu-follow");
    expect(sourceIconKind(source({ kind: "x", url: "https://x.com/example" }))).toBe("x");
    expect(sourceIconKind(source({ kind: "rss", config: { sourceProvider: "rsshub", rsshubPlatform: "xiaohongshu" } }))).toBe("xiaohongshu");
    expect(sourceFaviconCandidate(source({ kind: "x", url: "https://x.com/example" }))).toBeUndefined();
  });

  it("never turns a local or private icon URL into a renderer request", () => {
    expect(sourceFaviconCandidate(source({ iconUrl: "http://127.0.0.1/icon.ico" }))).toBe("https://example.com/favicon.ico");
    expect(sourceFaviconCandidate(source({ url: "http://localhost:3000/feed" }))).toBeUndefined();
  });
});
