import { describe, expect, it } from "vitest";
import { parseRobots, RobotsDisallowedError } from "../src/main/robots";
import { randomRefreshDelay, retryDelay } from "../src/main/database";

describe("scheduling safeguards", () => {
  it("uses the advertised 30–60 minute refresh window", () => {
    const delay = randomRefreshDelay();
    expect(delay).toBeGreaterThanOrEqual(30 * 60_000);
    expect(delay).toBeLessThanOrEqual(60 * 60_000);
  });

  it("backs off exponentially with a six-hour cap", () => {
    expect(retryDelay(1)).toBe(5 * 60_000);
    expect(retryDelay(2)).toBe(10 * 60_000);
    expect(retryDelay(20)).toBe(6 * 60 * 60_000);
  });
});

describe("robots parser", () => {
  it("reads wildcard disallow rules", () => {
    expect(parseRobots("User-agent: *\nDisallow: /private\nAllow: /")).toEqual(["/private"]);
  });

  it("distinguishes a robots restriction from an ordinary network failure", () => {
    const error = new RobotsDisallowedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RobotsDisallowedError");
    expect(error.message).toContain("不允许");
  });
});
