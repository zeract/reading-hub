import { describe, expect, it } from "vitest";
import { assertFeedSubscriptionUrl, assertPublicUrl, isTrustedLoopbackFeedUrl } from "../src/shared/url";

describe("public URL address boundary", () => {
  it.each([
    "https://[fd00::1]/", "https://[fc00::1]/", "https://[fe80::1]/", "https://[febf::1]/", "https://[fec0::1]/", "https://[ff02::1]/", "https://[::]/",
    "https://[::ffff:127.0.0.1]/", "https://[::ffff:192.168.1.1]/",
    "https://[::ffff:169.254.169.254]/", "https://169.254.169.254/", "https://100.64.0.1/",
    "https://0.1.2.3/", "https://224.0.0.1/", "https://255.255.255.255/", "https://2130706433/", "https://0x7f000001/",
    "https://localhost./", "https://sub.localhost/", "https://printer.local./",
    "https://user:fixture-password@example.com/"
  ])("rejects non-public or credential-bearing input %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });

  it.each(["https://example.com/", "http://example.com/feed", "https://8.8.8.8/", "https://100.63.255.255/", "https://100.128.0.1/", "https://172.15.255.255/", "https://172.32.0.1/", "https://[2606:4700:4700::1111]/", "https://[::ffff:8.8.8.8]/"])("keeps public input %s", (url) => {
    expect(assertPublicUrl(url)).toBeInstanceOf(URL);
  });

  it("keeps the explicit loopback Feed exception without permitting private-network or credential escapes", () => {
    expect(assertFeedSubscriptionUrl("http://127.0.0.1:1200/feed", true).hostname).toBe("127.0.0.1");
    expect(isTrustedLoopbackFeedUrl("http://[::1]:1200/feed")).toBe(true);
    expect(() => assertFeedSubscriptionUrl("http://[fd00::1]/feed", true)).toThrow();
    expect(() => assertFeedSubscriptionUrl("http://user:fixture-password@127.0.0.1/feed", true)).toThrow();
    expect(isTrustedLoopbackFeedUrl("http://user:fixture-password@127.0.0.1/feed")).toBe(false);
  });

  it("does not mistake a domain beginning with 127 for a trusted loopback feed", () => {
    expect(isTrustedLoopbackFeedUrl("https://127.example.com/feed")).toBe(false);
    expect(assertPublicUrl("https://127.example.com/feed").hostname).toBe("127.example.com");
  });
});
