import { describe, expect, it } from "vitest";
import { expectedImageProxyDiagnostic, findLeakedInlineMath, inspectReaderAuditArticle, readerAuditSessionUnavailable, readerAuditSummaryLead, ReaderAuditTimeoutError, runReaderAuditOperation, selectReaderAuditSamples } from "../src/main/reader-audit";
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
  it("does not mistake a mathematical blog for Scientific Spaces", () => {
    const entry = { ...auditEntry("math"), title: "Mathematical blog", summary: "An independent editorial summary that need not start the body." };
    const article = {
      entryId: entry.id, title: entry.title, url: "https://example.com/math", renderProfile: "scientific" as const,
      contentHtml: `<p>Mathematical blog ${"正文段落。".repeat(60)}</p>`
    };
    expect(inspectReaderAuditArticle(auditSource, entry, article).issues).toEqual([]);
    expect(inspectReaderAuditArticle(auditSource, entry, { ...article, url: entry.url }).issues)
      .toEqual(expect.arrayContaining(["科学空间页首元信息未清理", "科学空间正文起点与卡片摘要不一致"]));
    expect(inspectReaderAuditArticle(auditSource, entry, {
      ...article, contentHtml: `${article.contentHtml}<p>$q_i = x_i$</p>`
    }).issues).toContain("正文中残留未渲染的 $…$ 行内公式");
  });

  it("requires an explicitly supplied authorized session instead of a fresh audit profile", () => {
    const source = { ...auditSource, kind: "zhihu_follow" as const };
    expect(readerAuditSessionUnavailable(source, {})).toBe(true);
    expect(readerAuditSessionUnavailable(auditSource, {})).toBe(false);
    expect(readerAuditSessionUnavailable(source, { renderWithZhihuSession: async url => ({ url, html: "", title: "" }) })).toBe(false);
  });

  it.each(["feed_summary", "source_summary"] as const)("does not count %s as verified article content", contentMode => {
    const entry = auditEntry("summary");
    const result = inspectReaderAuditArticle(auditSource, entry, {
      entryId: entry.id, url: entry.url, title: entry.title, renderProfile: "standard", contentMode,
      contentHtml: `<p>${"现有摘要可安全显示，但不能证明原文已读取。".repeat(12)}</p>`
    });
    expect(result.issues).toContain("仅验证了已收集摘要，原文正文与公式未验证");
    expect(result.mode).toBe(contentMode);
    expect(result.entryId).toBe(entry.id);
  });
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
    expect(expectedImageProxyDiagnostic(new RobotsDisallowedError()))
      .toContain("robots.txt 不允许此路径");
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
