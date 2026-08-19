import { describe, expect, it, vi } from "vitest";
import { SourceProbe } from "../src/main/source-probe";

describe("SourceProbe platform boundaries", () => {
  it("rejects X profile URLs before the generic web probe reads a robots-blocked page", async () => {
    const http = { getText: vi.fn() };
    const probe = new SourceProbe(http as any);

    await expect(probe.probe("https://x.com/archiexzzz")).rejects.toThrow("不能通过“网页 / Feed”自动探测");
    await expect(probe.calibrate("https://twitter.com/archiexzzz")).rejects.toThrow("robots.txt 禁止自动读取");
    expect(http.getText).not.toHaveBeenCalled();
  });
});
