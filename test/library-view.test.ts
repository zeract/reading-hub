import { describe, expect, it } from "vitest";
import { entryQueryForLibrary } from "../src/renderer/library-view";

describe("library view queries", () => {
  it("keeps the Today view bounded to the local calendar day", () => {
    const now = new Date(2026, 7, 18, 15, 45, 12);

    expect(entryQueryForLibrary("today", "source-1", now)).toEqual({
      sourceId: "source-1",
      startAt: new Date(2026, 7, 18).getTime(),
      endAt: new Date(2026, 7, 19).getTime()
    });
  });

  it("does not silently trim unread or favourite history after removing date ranges", () => {
    expect(entryQueryForLibrary("unread")).toEqual({ sourceId: undefined, read: false });
    expect(entryQueryForLibrary("unread", "source-1")).toEqual({ sourceId: undefined, read: false });
    expect(entryQueryForLibrary("favorite", "source-1")).toEqual({ sourceId: "source-1", favorite: true });
    expect(entryQueryForLibrary("all")).toEqual({ sourceId: undefined });
  });

  it("adds a keyword only to an explicitly selected source", () => {
    expect(entryQueryForLibrary("all", "source-1", undefined, "vector database"))
      .toEqual({ sourceId: "source-1", search: "vector database" });
    expect(entryQueryForLibrary("unread", "source-1", undefined, "vector database"))
      .toEqual({ sourceId: undefined, read: false });
  });
});
