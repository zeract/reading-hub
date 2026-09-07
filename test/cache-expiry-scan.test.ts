import { afterEach, expect, it, vi } from "vitest";
import { WeightedLruCache } from "../src/main/weighted-lru-cache";

type Value = { expiresAt?: number; text: string };
const create = () => new WeightedLruCache<string, Value>({ maxEntries: 240, maxWeight: 240, weight: () => 1, expiresAt: (value) => value.expiresAt! });
function visitedEntries(cache: WeightedLruCache<string, Value>) {
  const records = (cache as unknown as { entries: Map<string, unknown> }).entries;
  const iterator = records[Symbol.iterator].bind(records);
  let visited = 0;
  vi.spyOn(records, Symbol.iterator).mockImplementation(function* () {
    for (const record of iterator()) { visited++; yield record; }
  });
  return () => visited;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([false, true])("does not sweep 240 live entries on every hit (expiry enabled: %s)", (expires) => {
  vi.useFakeTimers(); vi.setSystemTime(100);
  const cache = expires ? create() : new WeightedLruCache<string, Value>({ maxEntries: 240, maxWeight: 240, weight: () => 1 });
  for (let index = 0; index < 240; index++) cache.set(String(index), { text: "fixture", ...(expires ? { expiresAt: 100_000 } : {}) });
  const visits = visitedEntries(cache);
  for (let index = 0; index < 1000; index++) expect(cache.get(String(index % 240))?.text).toBe("fixture");
  expect(visits()).toBe(0);
});

it("expires newly inserted earlier deadlines on time without rescanning the remaining live entries", () => {
  vi.useFakeTimers(); vi.setSystemTime(100);
  const cache = create();
  cache.set("long", { text: "long", expiresAt: 1000 });
  cache.set("short", { text: "short", expiresAt: 200 });
  const visits = visitedEntries(cache);
  vi.setSystemTime(199); expect(cache.get("short")?.text).toBe("short");
  expect(visits()).toBe(0);
  vi.setSystemTime(200); expect(cache.get("short")).toBeUndefined();
  const afterExpiry = visits();
  expect(afterExpiry).toBeGreaterThan(0);
  for (let index = 0; index < 20; index++) expect(cache.get("long")?.text).toBe("long");
  expect(visits()).toBe(afterExpiry);
  vi.setSystemTime(1000); expect(cache.get("long")).toBeUndefined();
});

it("handles replaced and deleted deadlines, immortal values and clock rollback", () => {
  vi.useFakeTimers(); vi.setSystemTime(100);
  const cache = create();
  cache.set("replace", { text: "old", expiresAt: 200 });
  cache.set("delete", { text: "deleted", expiresAt: 150 });
  cache.set("forever", { text: "forever" });
  cache.set("replace", { text: "new", expiresAt: 400 });
  cache.delete("delete");
  vi.setSystemTime(200); expect(cache.get("replace")?.text).toBe("new");
  vi.setSystemTime(50); cache.set("earlier", { text: "earlier", expiresAt: 75 });
  vi.setSystemTime(75); expect(cache.get("earlier")).toBeUndefined();
  expect(cache.get("replace")?.text).toBe("new");
  vi.setSystemTime(400); expect(cache.get("replace")).toBeUndefined();
  expect(cache.get("forever")?.text).toBe("forever");
  const visits = visitedEntries(cache);
  vi.setSystemTime(5000); expect(cache.get("forever")?.text).toBe("forever");
  expect(visits()).toBe(0);
});
