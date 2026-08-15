import { describe, expect, it } from "vitest";
import { codexExecArguments } from "../src/main/codex-cli";

describe("local Codex CLI invocation", () => {
  it("uses an explicit model and bounded effort in ephemeral, read-only mode", () => {
    const args = codexExecArguments("回答文章问题", { model: "gpt-5.3-codex", effort: "high" });

    expect(args).toEqual(["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-5.3-codex", "--config", "model_reasoning_effort=high", "回答文章问题"]);
    expect(args).not.toContain("--full-auto");
    expect(args).not.toContain("danger-full-access");
  });

  it("keeps the user's CLI model when no model override is selected", () => {
    expect(codexExecArguments("回答文章问题", { effort: "medium" })).toEqual([
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--config", "model_reasoning_effort=medium", "回答文章问题"
    ]);
  });
});
