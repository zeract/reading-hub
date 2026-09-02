import { describe, expect, it } from "vitest";
import {
  codexAppServerAgentDelta,
  codexAppServerArguments,
  codexAppServerThreadStartParameters,
  codexAppServerTurnStartParameters,
  codexExecArguments
} from "../src/main/codex-cli";

describe("local Codex CLI invocation", () => {
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
