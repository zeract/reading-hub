import { describe, expect, it } from "vitest";
import { expectedImageProxyDiagnostic, findLeakedInlineMath, readerAuditSummaryLead, ReaderAuditTimeoutError, runReaderAuditOperation, selectReaderAuditSamples } from "../src/main/reader-audit";
import { UnsupportedReaderImageTypeError } from "../src/main/http";
import { RobotsDisallowedError } from "../src/main/robots";
import type { Entry, Source } from "../src/shared/types";

const auditSource: Source = {
  id: "science-source",
  url: "https://kexue.fm/feed",
  title: "科学空间",
  kind: "rss",
  status: "active",
  pollingEnabled: true,
  consecutiveEmpty: 0,
  failureCount: 0,
  createdAt: 1,
  updatedAt: 1
};

function auditEntry(id: string): Entry {
  return {
    id,
    sourceId: auditSource.id,
    canonicalUrl: `https://kexue.fm/archives/${id}`,
    url: `https://kexue.fm/archives/${id}`,
    title: `文章 ${id}`,
    contentHash: id,
    read: false,
    favorite: false,
    createdAt: 1
  };
}

describe("reader audit cancellation", () => {
  it("uses every entry only when a full source audit is explicitly requested", () => {
    const entries = [auditEntry("newest"), auditEntry("middle"), auditEntry("oldest")];

    expect(selectReaderAuditSamples(auditSource, entries).map((sample) => [sample.entry.id, sample.sample])).toEqual([
      ["newest", "newest"],
      ["middle", "historical"]
    ]);
    expect(selectReaderAuditSamples(auditSource, entries, true).map((sample) => [sample.entry.id, sample.sample])).toEqual([
      ["newest", "all"],
      ["middle", "all"],
      ["oldest", "all"]
    ]);
  });

  it("records an SVG proxy exclusion as safe reader metadata instead of an image failure", () => {
    expect(expectedImageProxyDiagnostic(new UnsupportedReaderImageTypeError("image/svg+xml")))
      .toContain("SVG");
    expect(expectedImageProxyDiagnostic(new UnsupportedReaderImageTypeError("text/html"))).toBeUndefined();
    expect(expectedImageProxyDiagnostic(new RobotsDisallowedError("https://example.com/image.jpg")))
      .toContain("robots.txt");
    expect(expectedImageProxyDiagnostic(new Error("图片请求失败（HTTP 403）"))).toBeUndefined();
  });

  it("distinguishes escaped inline TeX from currency prose and account handles", () => {
    expect(findLeakedInlineMath("The plan costs $3.65/M. Separately, @ZixuanLi_ shared an update; another price is $12.")).toEqual([]);
    expect(findLeakedInlineMath("$19,200/mo Mid 2× i4i.8xlarge (32 vCPU) 2× NVMe RAID0 446,667 24,000 44ms 109ms ~$"))
      .toEqual([]);
    expect(findLeakedInlineMath("The reader leaked $q_i = q^2$ and $\\frac{a}{b}$.")).toEqual(["$q_i = q^2$", "$\\frac{a}{b}$"]);
  });

  it("compares Scientific Spaces summaries by their prose lead before raw TeX", () => {
    expect(readerAuditSummaryLead("一个以动量为状态变量的优化器，基本形式如下：\\begin{equation}\\boldsymbol{M}_t = \\beta\\boldsymbol{M}_{t-1}")).toBe("一个以动量为状态变量的优化器，基本形式如下：");
    expect(readerAuditSummaryLead("纯文本摘要没有公式。")).toBe("纯文本摘要没有公式。");
    expect(readerAuditSummaryLead("\\[q_i = x_i\\]")).toBe("");
  });

  it("aborts the underlying sample operation before reporting its deadline", async () => {
    let cancelled = false;
    const heartbeats: number[] = [];
    const result = runReaderAuditOperation(
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          cancelled = true;
          reject(signal.reason);
        }, { once: true });
      }),
      30,
      "正文读取",
      (elapsedMs) => heartbeats.push(elapsedMs),
      5
    );

    await expect(result).rejects.toBeInstanceOf(ReaderAuditTimeoutError);
    expect(cancelled).toBe(true);
    expect(heartbeats.length).toBeGreaterThan(0);
  });

  it("returns at the deadline even when an injected dependency ignores cancellation", async () => {
    let signalWasAborted = false;
    const startedAt = Date.now();
    const result = runReaderAuditOperation(
      (signal) => {
        signal.addEventListener("abort", () => { signalWasAborted = true; }, { once: true });
        return new Promise<never>(() => undefined);
      },
      20,
      "首图检查"
    );

    await expect(result).rejects.toThrow("首图检查超时");
    expect(signalWasAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(300);
  });
});
