import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({ access }));

import {
  BoundedAsyncSemaphore,
  CODEX_COMMAND_DISCOVERY_TTL_MS,
  CodexCliError,
  LocalCodexCli,
  codexAppServerAgentDelta,
  codexAppServerArguments,
  codexAppServerThreadStartParameters,
  codexAppServerTurnStartParameters,
  codexExecArguments,
  invalidateCodexCommandDiscovery,
  throwIfCodexCancelled
} from "../src/main/codex-cli";

afterEach(() => {
  invalidateCodexCommandDiscovery();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("local Codex CLI invocation", () => {
  it("atomically hands released App Server capacity to FIFO waiters", async () => {
    const semaphore = new BoundedAsyncSemaphore(2);
    let maxObservedActive = 0;
    const observe = () => { maxObservedActive = Math.max(maxObservedActive, semaphore.activeCount); };

    const releaseFirst = await semaphore.acquire();
    observe();
    const releaseSecond = await semaphore.acquire();
    observe();
    const third = semaphore.acquire();
    const fourth = semaphore.acquire();
    const fifth = semaphore.acquire();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(3);

    // While the third caller is being woken, a fresh fifth caller is already
    // queued. The released slot must remain reserved for the third caller.
    releaseFirst();
    observe();
    expect(semaphore.activeCount).toBe(2);
    const releaseThird = await third;
    observe();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(2);

    releaseSecond();
    observe();
    const releaseFourth = await fourth;
    observe();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(1);

    releaseThird();
    observe();
    const releaseFifth = await fifth;
    observe();
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.queuedCount).toBe(0);

    releaseFourth();
    releaseFifth();
    observe();
    expect(maxObservedActive).toBeLessThanOrEqual(2);
    expect(semaphore.activeCount).toBe(0);
  });

  it("removes a cancelled queued caller without consuming a later slot", async () => {
    const semaphore = new BoundedAsyncSemaphore(1);
    const releaseFirst = await semaphore.acquire();
    const controller = new AbortController();
    const cancelled = semaphore.acquire({ signal: controller.signal, abortError: () => new CodexCliError("AI 请求已取消。") });
    expect(semaphore.queuedCount).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toThrow("AI 请求已取消。");
    expect(semaphore.queuedCount).toBe(0);

    releaseFirst();
    const releaseNext = await semaphore.acquire();
    expect(semaphore.activeCount).toBe(1);
    releaseNext();
  });

  it("identifies caller cancellation before creating a local App Server turn", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfCodexCancelled(controller.signal)).toThrow(CodexCliError);
    expect(() => throwIfCodexCancelled(controller.signal)).toThrow("AI 请求已取消。");
  });

  it("shares short-lived command discovery across concurrent status checks, then rechecks after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    access.mockResolvedValue(undefined);
    const cli = new LocalCodexCli();

    const [first, second] = await Promise.all([cli.status(), cli.status()]);
    expect(first).toMatchObject({ available: true });
    expect(second).toEqual(first);
    // The first executable candidate succeeds, so one access proves that the
    // two status calls joined the same in-flight PATH discovery.
    expect(access).toHaveBeenCalledTimes(1);

    await cli.status();
    expect(access).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CODEX_COMMAND_DISCOVERY_TTL_MS + 1);
    await cli.status();
    expect(access).toHaveBeenCalledTimes(2);
  });

  it("caches a missing command only for the same short discovery window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    access.mockRejectedValue(new Error("not installed"));
    const cli = new LocalCodexCli();

    await expect(cli.status()).resolves.toEqual({ available: false });
    const firstScanAttempts = access.mock.calls.length;
    expect(firstScanAttempts).toBeGreaterThan(0);
    await expect(cli.status()).resolves.toEqual({ available: false });
    expect(access).toHaveBeenCalledTimes(firstScanAttempts);

    vi.advanceTimersByTime(CODEX_COMMAND_DISCOVERY_TTL_MS + 1);
    await expect(cli.status()).resolves.toEqual({ available: false });
    expect(access.mock.calls.length).toBeGreaterThan(firstScanAttempts);
  });

  it("uses an explicit model and bounded effort in ephemeral, read-only mode", () => {
    const args = codexExecArguments("回答文章问题", { model: "gpt-5.6-sol", effort: "high" });

    expect(args).toEqual(["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-5.6-sol", "--config", "model_reasoning_effort=high", "回答文章问题"]);
    expect(args).not.toContain("--full-auto");
    expect(args).not.toContain("danger-full-access");
  });

  it("keeps the user's CLI model when no model override is selected", () => {
    expect(codexExecArguments("回答文章问题", { effort: "medium" })).toEqual([
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--config", "model_reasoning_effort=medium", "回答文章问题"
    ]);
  });

  it("passes the latest Codex model identifiers and maximum reasoning unchanged", () => {
    const args = codexExecArguments("解释文章", { model: "gpt-5.6-terra", effort: "max" });
    expect(args).toContain("gpt-5.6-terra");
    expect(args).toContain("model_reasoning_effort=max");
  });

  it("keeps JSONL exec mode as a bounded compatibility fallback", () => {
    const args = codexExecArguments("解释文章", { effort: "medium" }, true);
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
  });

  it("uses the app-server delta protocol without forwarding non-message events", () => {
    expect(codexAppServerArguments()).toEqual(["app-server", "--listen", "stdio://"]);
    expect(codexAppServerAgentDelta({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "正在" }
    }, "thread-1")).toBe("正在");
    expect(codexAppServerAgentDelta({ method: "item/agentMessage/delta", params: { threadId: "other", delta: "忽略" } }, "thread-1")).toBeUndefined();
    expect(codexAppServerAgentDelta({ method: "item/started", params: { threadId: "thread-1" } }, "thread-1")).toBeUndefined();
  });

  it("creates a fresh read-only ephemeral thread for every local reader question", () => {
    const parameters = codexAppServerThreadStartParameters("解释这个段落");

    expect(parameters).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: expect.stringContaining("解释这个段落")
    });
    expect(parameters.baseInstructions).toContain("不得调用工具、读取或写入文件、运行命令或访问网络");
    expect(JSON.stringify(parameters)).not.toContain("danger-full-access");
  });

  it("sends article text through an isolated turn while preserving the chosen model and effort", () => {
    expect(codexAppServerTurnStartParameters("thread-1", "文章摘录", { model: "gpt-5.6-luna", effort: "low" })).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "文章摘录", text_elements: [] }],
      model: "gpt-5.6-luna",
      effort: "low"
    });
    expect(codexAppServerTurnStartParameters("thread-1", "文章摘录", { effort: "medium" })).not.toHaveProperty("model");
  });
});
