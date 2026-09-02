import { describe, expect, it } from "vitest";
import { isSameLibrarySelection } from "../src/renderer/source-selection";

describe("library selection", () => {
  it("recognises a repeated Today selection as the same effective query", () => {
    expect(isSameLibrarySelection(
      { view: "today", sourceId: undefined, search: "" },
      { view: "today", sourceId: undefined, search: "" }
    )).toBe(true);
  });

  it("treats a repeated source selection as the same effective query", () => {
    expect(isSameLibrarySelection(
      { view: "all", sourceId: "source-a", search: "" },
      { view: "all", sourceId: "source-a", search: "" }
    )).toBe(true);
  });

  it("uses the normal query effect when a view, source, or search changes", () => {
    const current = { view: "all" as const, sourceId: "source-a", search: "linear attention" };
    expect(isSameLibrarySelection(current, { view: "all", sourceId: "source-b", search: "" })).toBe(false);
    expect(isSameLibrarySelection(current, { view: "today", sourceId: undefined, search: "" })).toBe(false);
    expect(isSameLibrarySelection(current, { view: "all", sourceId: "source-a", search: "sparse attention" })).toBe(false);
  });
});
