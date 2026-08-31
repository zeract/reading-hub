import { describe, expect, it } from "vitest";
import { defaultSubscriptionScope, entryMatchesSubscriptionScope, normaliseSubscriptionScope } from "../src/shared/subscription-scope";

describe("subscription collection scope", () => {
  const systems = { scheme: "feed:https://example.com:category", key: "systems", label: "系统" };
  const ml = { scheme: "feed:https://example.com:category", key: "ml", label: "机器学习" };

  it("defaults to current Feed collection without a category restriction", () => {
    const scope = defaultSubscriptionScope();
    expect(scope).toEqual({ facetSelections: [], history: { mode: "none" } });
    expect(entryMatchesSubscriptionScope({}, scope)).toBe(true);
  });

  it("uses exact scheme/key matching with OR semantics for selected categories", () => {
    const scope = { facetSelections: [systems, ml], history: { mode: "selected" as const, limit: 100 } };
    expect(entryMatchesSubscriptionScope({ facets: [systems] }, scope)).toBe(true);
    expect(entryMatchesSubscriptionScope({ facets: [{ ...systems, label: "系统文章" }] }, scope)).toBe(true);
    expect(entryMatchesSubscriptionScope({ facets: [{ scheme: "feed:https://other.example:category", key: "systems", label: "系统" }] }, scope)).toBe(false);
    expect(entryMatchesSubscriptionScope({}, scope)).toBe(false);
  });

  it("drops invalid metadata and keeps the no-history default conservative", () => {
    expect(normaliseSubscriptionScope({
      facetSelections: [{ scheme: " ", key: "bad", label: "Bad" }, systems],
      history: { mode: "none", limit: 500 }
    })).toEqual({ facetSelections: [systems], history: { mode: "none" } });
  });
});
