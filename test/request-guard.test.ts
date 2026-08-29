import { describe, expect, it } from "vitest";
import { LatestRequestGuard } from "../src/renderer/request-guard";

describe("LatestRequestGuard", () => {
  it("rejects an older response after a newer article request begins", () => {
    const guard = new LatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("rejects an in-flight response when its owning view is replaced", () => {
    const guard = new LatestRequestGuard();
    const request = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(request)).toBe(false);
  });
});
