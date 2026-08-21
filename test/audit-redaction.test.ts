import { describe, expect, it } from "vitest";
import { redactAuditMessage, redactAuditUrl } from "../src/main/audit-redaction";

describe("audit report redaction", () => {
  it("retains a useful endpoint shape without exposing its query parameters", () => {
    expect(redactAuditUrl("https://scour.ing/@Zeract/rss.xml?as=Zeract&token=super-secret#fragment"))
      .toBe("https://scour.ing/@Zeract/rss.xml?…");
  });

  it("removes credentials from HTTP failures before they reach the report", () => {
    expect(redactAuditMessage("fetch https://example.com/feed?access_token=top-secret failed; Bearer abc.def token=also-secret"))
      .toBe("fetch https://example.com/feed?… failed; Bearer [redacted] token=[redacted]");
  });
});
