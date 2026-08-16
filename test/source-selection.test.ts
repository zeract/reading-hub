import { describe, expect, it } from "vitest";
import { requiresSourceReload } from "../src/renderer/source-selection";

describe("source selection", () => {
  it("reloads when the user clicks the already active source", () => {
    expect(requiresSourceReload("source-a", "source-a")).toBe(true);
    expect(requiresSourceReload(undefined, undefined)).toBe(true);
  });

  it("uses the normal state-change refresh for a different source", () => {
    expect(requiresSourceReload("source-a", "source-b")).toBe(false);
    expect(requiresSourceReload("source-a", undefined)).toBe(false);
  });
});
