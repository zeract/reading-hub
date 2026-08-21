import { describe, expect, it } from "vitest";
import { findLeakedInlineMath, ReaderAuditTimeoutError, runReaderAuditOperation } from "../src/main/reader-audit";

describe("reader audit cancellation", () => {
  it("distinguishes escaped inline TeX from currency prose and account handles", () => {
    expect(findLeakedInlineMath("The plan costs $3.65/M. Separately, @ZixuanLi_ shared an update; another price is $12.")).toEqual([]);
    expect(findLeakedInlineMath("The reader leaked $q_i = q^2$ and $\\frac{a}{b}$.")).toEqual(["$q_i = q^2$", "$\\frac{a}{b}$"]);
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
