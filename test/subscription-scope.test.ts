import { describe, expect, it } from "vitest";
import { defaultSubscriptionScope, createSubscriptionScopeMatcher, normaliseSubscriptionScope, sameSubscriptionScope } from "../src/shared/subscription-scope";

describe("subscription collection scope", () => {
  const systems = { scheme: "feed:https://example.com:category", key: "systems", label: "系统" };
  const ml = { scheme: "feed:https://example.com:category", key: "ml", label: "机器学习" };

  it("compares collection semantics independently of display labels and selection order", () => {
    const original = { facetSelections: [systems, ml], history: { mode: "selected" as const, limit: 100 } };
    expect(sameSubscriptionScope(original, { ...original, facetSelections: [ml, { ...systems, label: "New label" }, ml] })).toBe(true);
    expect(sameSubscriptionScope(original, { ...original, history: { mode: "selected", limit: 101 } })).toBe(false);
    expect(sameSubscriptionScope(original, { ...original, history: { mode: "none" } })).toBe(false);
    expect(sameSubscriptionScope(original, { ...original, facetSelections: [{ ...systems, key: "changed" }, ml] })).toBe(false);
    expect(sameSubscriptionScope(undefined, { facetSelections: [], history: { mode: "none", limit: 50 } })).toBe(true);
  });

  it("defaults to current Feed collection without a category restriction", () => {
    const scope = defaultSubscriptionScope();
    expect(scope).toEqual({ facetSelections: [], history: { mode: "none" } });
    expect(createSubscriptionScopeMatcher(scope)({})).toBe(true);
  });

  it("uses exact scheme/key matching with OR semantics for selected categories", () => {
    const scope = { facetSelections: [systems, ml], history: { mode: "selected" as const, limit: 100 } };
    expect(createSubscriptionScopeMatcher(scope)({ facets: [systems] })).toBe(true);
    expect(createSubscriptionScopeMatcher(scope)({ facets: [{ ...systems, label: "系统文章" }] })).toBe(true);
    expect(createSubscriptionScopeMatcher(scope)({ facets: [{ scheme: "feed:https://other.example:category", key: "systems", label: "系统" }] })).toBe(false);
    expect(createSubscriptionScopeMatcher(scope)({})).toBe(false);
  });

  it("drops invalid metadata and keeps the no-history default conservative", () => {
    expect(normaliseSubscriptionScope({
      facetSelections: [{ scheme: " ", key: "bad", label: "Bad" }, systems],
      history: { mode: "none", limit: 500 }
    })).toEqual({ facetSelections: [systems], history: { mode: "none" } });
  });

  it("keeps a compiled batch independent of subsequent selection mutations", () => {
    const selected = { ...systems };
    const scope = { facetSelections: [selected], history: { mode: "none" as const } };
    const matches = createSubscriptionScopeMatcher(scope);
    selected.key = "changed";
    scope.facetSelections.push(ml);
    expect(matches({ facets: [systems] })).toBe(true);
    expect(matches({ facets: [ml] })).toBe(false);
    expect(createSubscriptionScopeMatcher(scope)({ facets: [ml] })).toBe(true);
  });

  it("retains validation, deduplication and record limits while matching", () => {
    const facets = Array.from({ length: 64 }, (_, index) => ({ ...systems, key: String(index) }));
    const matches = createSubscriptionScopeMatcher({ facetSelections: [ml], history: { mode: "none" } });
    expect(matches({ facets: [...facets, ml] })).toBe(false);
    expect(matches({ facets: [{ ...ml, label: " " }] })).toBe(false);
    expect(matches({ facets: [...Array.from({ length: 64 }, () => systems), ml] })).toBe(true);
  });
});
