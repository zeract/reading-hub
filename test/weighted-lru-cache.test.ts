import { afterEach, describe, expect, it, vi } from "vitest";
import { WeightedLruCache } from "../src/main/weighted-lru-cache";

afterEach(() => { vi.useRealTimers(); });
const cache = (maxEntries = 3, maxWeight = 10) => new WeightedLruCache<string, string>({ maxEntries, maxWeight, weight: (key, value) => key.length + value.length });

describe("weighted LRU retention contract", () => {
  it("counts keys and values, keeping exact-budget entries and evicting the coldest", () => {
    const store = cache();
    store.set("a", "1111");
    store.set("b", "2222");
    expect(store.get("a")).toBe("1111");
    store.set("c", "3");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe("1111");
    expect(store.get("c")).toBe("3");
  });

  it("releases replaced weights without evicting unrelated entries", () => {
    const store = cache();
    store.set("a", "1111");
    store.set("a", "1");
    store.set("b", "2222222");
    expect(store.get("a")).toBe("1");
    expect(store.get("b")).toBe("2222222");
    store.set("a", "444444444");
    expect(store.get("a")).toBe("444444444");
    expect(store.get("b")).toBeUndefined();
  });

  it("does not retain stale values when a replacement cannot fit", () => {
    const store = cache();
    store.set("a", "1");
    store.set("b", "2");
    store.set("a", "x".repeat(10));
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe("2");
  });

  it("limits even zero-cost entries by recency", () => {
    const store = new WeightedLruCache<number, string>({ maxEntries: 2, maxWeight: 1, weight: () => 0 });
    store.set(1, "first"); store.set(2, "second");
    store.get(1); store.set(3, "third");
    expect(store.get(2)).toBeUndefined();
    expect(store.get(1)).toBe("first");
    expect(store.get(3)).toBe("third");
  });

  it("expires hot entries at their original deadline and reclaims colder expired entries first", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const store = new WeightedLruCache<string, number>({ maxEntries: 2, maxWeight: 2, weight: () => 1, expiresAt: (value) => value });
    store.set("valid", 100); store.set("short", 10);
    vi.setSystemTime(9); expect(store.get("short")).toBe(10);
    vi.setSystemTime(10); store.set("new", 100);
    expect(store.get("short")).toBeUndefined();
    expect(store.get("valid")).toBe(100);
    expect(store.get("new")).toBe(100);
    vi.setSystemTime(100);
    expect(store.get("valid")).toBeUndefined();
    expect(store.get("new")).toBeUndefined();
  });

  it("does not retain already expired replacements", () => {
    vi.useFakeTimers(); vi.setSystemTime(100);
    const store = new WeightedLruCache<string, number>({ maxEntries: 1, maxWeight: 1, weight: () => 1, expiresAt: (value) => value });
    store.set("same", 200); store.set("same", 100);
    expect(store.get("same")).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 1.5])("cannot bypass the cost limit with weight %s", (weight) => {
    const store = new WeightedLruCache<string, string>({ maxEntries: 1, maxWeight: 10, weight: () => weight });
    store.set("invalid", "value");
    expect(store.get("invalid")).toBeUndefined();
  });
});
