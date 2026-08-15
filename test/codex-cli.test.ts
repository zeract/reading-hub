import { describe, expect, it } from "vitest";
import { codexExecArguments } from "../src/main/codex-cli";

describe("local Codex CLI invocation", () => {
  it("uses ephemeral, read-only non-interactive mode", () => {
    const args = codexExecArguments("回答文章问题");

    expect(args).toEqual(["exec", "--ephemeral", "--sandbox", "read-only", "回答文章问题"]);
    expect(args).not.toContain("--full-auto");
    expect(args).not.toContain("danger-full-access");
  });
});
