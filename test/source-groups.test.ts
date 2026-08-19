import { describe, expect, it } from "vitest";
import { groupSources } from "../src/renderer/source-groups";
import type { Source } from "../src/shared/types";

function source(title: string, kind: Source["kind"], category?: string, config?: Source["config"]): Source {
  return {
    id: title,
    url: `https://example.com/${title}`,
    title,
    category,
    config,
    kind,
    status: "active",
    pollingEnabled: true,
    consecutiveEmpty: 0,
    failureCount: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

describe("source folders", () => {
  it("uses sensible local folders for existing connector types and supports custom folders", () => {
    const sources = [
      source("Zeta", "generic"),
      source("知乎", "zhihu_follow"),
      source("小红书博主", "rss", undefined, { sourceProvider: "rsshub", rsshubPlatform: "xiaohongshu" }),
      source("论文", "academic"),
      source("Alpha", "rss", "机器学习")
    ];

    expect(groupSources(sources).map((group) => [group.title, group.sources.map((item) => item.title)])).toEqual([
      ["网页与订阅", ["Zeta"]],
      ["平台动态", ["小红书博主", "知乎"]],
      ["学术追踪", ["论文"]],
      ["机器学习", ["Alpha"]]
    ]);
    expect(sources[0].category).toBeUndefined();
  });
});
