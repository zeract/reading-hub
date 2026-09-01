import { describe, expect, it } from "vitest";
import type { Entry, EntryListQuery } from "../src/shared/types";
import { ENTRY_PAGE_SIZE, firstEntryPageQuery, mergeEntryPages, nextEntryPageQuery } from "../src/renderer/entry-pagination";

function entry(id: string): Entry {
  return {
    id,
    sourceId: "source-1",
    canonicalUrl: `https://example.com/${id}`,
    url: `https://example.com/${id}`,
    title: id,
    contentHash: id,
    read: false,
    favorite: false,
    createdAt: 10,
    observedAt: 10
  };
}

describe("entry pagination", () => {
  it("keeps library filters while adding a bounded continuation cursor", () => {
    const query: EntryListQuery = { sourceId: "source-1", favorite: true };
    const cursor = { publishedAt: 100, observedAt: 100, createdAt: 100, id: "entry-100" };

    expect(firstEntryPageQuery(query)).toEqual({ ...query, pageSize: ENTRY_PAGE_SIZE });
    expect(nextEntryPageQuery(query, cursor)).toEqual({ ...query, pageSize: ENTRY_PAGE_SIZE, cursor });
  });

  it("deduplicates revalidated cards without changing their newest-first order", () => {
    expect(mergeEntryPages([entry("new"), entry("shared")], [entry("shared"), entry("old")]).map((item) => item.id))
      .toEqual(["new", "shared", "old"]);
  });
});
