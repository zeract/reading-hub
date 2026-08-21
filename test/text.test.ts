import { describe, expect, it } from "vitest";
import { parsePublishedAt } from "../src/shared/text";

describe("parsePublishedAt", () => {
  it("accepts ISO timestamps as emitted by RSS parsers", () => {
    expect(parsePublishedAt("2024-02-04T23:23:27.000Z")).toBe(Date.UTC(2024, 1, 4));
  });

  it("keeps parsing RFC feed dates and rejects unrelated version-like text", () => {
    expect(parsePublishedAt("Sun, 04 Feb 2024 17:23:27 -0600")).toBe(Date.UTC(2024, 1, 4));
    expect(parsePublishedAt("Ubuntu 12.04")).toBeUndefined();
  });

  it("parses a named list-card date even when markup concatenates the following title", () => {
    expect(parsePublishedAt("Jul 29, 2026Securing Agents Across Client Endpoints")).toBe(Date.UTC(2026, 6, 29));
  });
});
