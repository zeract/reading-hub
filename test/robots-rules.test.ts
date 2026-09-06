import { describe, expect, it } from "vitest";
import { isRobotsPathAllowed, parseRobots } from "../src/main/robots-rules";

const allowed = (rules: string, path: string) => isRobotsPathAllowed(parseRobots(rules), path);

describe("robots group selection", () => {
  it("merges repeated specific groups case-insensitively", () => {
    const rules = "User-agent: READINGHUB\nDisallow: /one\nUser-agent: Other\nDisallow: /other\nUser-agent: readinghub\nDisallow: /two";
    expect(allowed(rules, "/one")).toBe(false);
    expect(allowed(rules, "/two")).toBe(false);
    expect(allowed(rules, "/other")).toBe(true);
  });
  it("honors an empty final specific group instead of falling back to wildcard", () => {
    expect(allowed("User-agent: *\nDisallow: /\nUser-agent: ReadingHub", "/post")).toBe(true);
  });
  it("treats empty rules as a group separator but not a restriction", () => {
    expect(allowed("User-agent: ReadingHub\nDisallow: \nUser-agent: Other\nDisallow: /", "/post")).toBe(true);
  });
  it("does not let comments, blank lines or other records separate shared agents", () => {
    expect(allowed("\uFEFFUser-Agent: ReadingHub\r# comment\rSitemap: https://example.com/map\r\rUser-agent: Other\rDisallow: /secret # tail", "/secret")).toBe(false);
  });
  it("combines wildcard groups and ignores orphan rules and unrelated agents", () => {
    const rules = "Disallow: /orphan\nUser-agent: *\nDisallow: /one\nUser-agent: Other\nDisallow: /other\nUser-agent: *\nDisallow: /two";
    expect(allowed(rules, "/orphan")).toBe(true);
    expect(allowed(rules, "/other")).toBe(true);
    expect(allowed(rules, "/one")).toBe(false);
    expect(allowed(rules, "/two")).toBe(false);
  });
  it("ignores malformed records without dropping following valid rules", () => {
    expect(allowed("User-agent: ReadingHub\nDisallow: relative\nAllow: /bad\0value\nBroken\nDisallow: /valid", "/valid")).toBe(false);
  });
});

describe("robots path matching", () => {
  it.each([
    ["Disallow: /\nAllow: /public", "/public/post", true],
    ["Allow: /public\nDisallow: /public/private", "/public/private", false],
    ["Disallow: /same\nAllow: /same", "/same", true],
    ["Allow: /same\nDisallow: /same", "/same", true],
    ["Disallow: /Private", "/private", true],
    ["Disallow: /*.pdf$", "/one/two.pdf", false],
    ["Disallow: /*.pdf$", "/one/two.pdf?download=1", true],
    ["Disallow: *.pdf$", "/paper.pdf", false],
    ["Disallow: /a*b*c$", "/a/b/c/c", false],
    ["Disallow: /a*b*c$", "/a/b/c/extra", true],
    ["Disallow: /a**b*", "/ab", false],
    ["Disallow: /foo", "/foobar", false],
    ["Disallow: /foo$", "/foobar", true],
    ["Disallow: /", "/robots.txt", true],
    ["Disallow: /搜索", "/%E6%90%9C%E7%B4%A2", false],
    ["Disallow: /path\u00a0", "/path", true],
    ["Disallow: /path\u00a0", "/path%C2%A0", false],
    ["Disallow: /%e6%90%9c%e7%b4%a2", "/搜索", false],
    ["Disallow: /%70rivate", "/private", false],
    ["Disallow: /private", "/%70rivate", false],
    ["Disallow: /a%2fb", "/a%2Fb", false],
    ["Disallow: /a%2Fb", "/a/b", true],
    ["Disallow: /file%2A", "/file*", false],
    ["Disallow: /file%2A", "/fileXYZ", true],
    ["Disallow: /price%24", "/price$", false],
    ["Disallow: /price$usd", "/price%24usd", false],
    ["Disallow: /x%23y # comment", "/x%23y", false],
    ["Disallow: /search?q=private", "/search?q=private&sort=date", false],
    ["Disallow: /[a]+.(b)", "/[a]+.(b)", false],
    ["Disallow: /[a]+.(b)", "/aaab", true]
  ] as const)("evaluates %s against %s", (rules, path, expected) => {
    expect(allowed(`User-agent: *\n${rules}`, path)).toBe(expected);
  });

  it("handles repeated wildcard fragments without regex backtracking", () => {
    expect(allowed(`User-agent: *\nDisallow: /${"*a".repeat(2000)}b$`, `/${"a".repeat(4000)}c`)).toBe(true);
  });
});
