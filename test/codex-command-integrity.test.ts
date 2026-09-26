import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  realpath: vi.fn(), access: vi.fn(), stat: vi.fn()
}));
const process = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => files);
vi.mock("node:child_process", () => process);
import { trustedCodexExecutable } from "../src/main/codex-command-integrity";

beforeEach(() => {
  vi.clearAllMocks();
  files.access.mockResolvedValue(undefined);
  files.stat.mockResolvedValue({ size: 100, mtimeMs: 100 });
});

it("rejects a modified npm Codex native payload before its JavaScript shim can launch it", async () => {
  files.realpath.mockResolvedValue("/tmp/invalid-a/@openai/codex/bin/codex.js");
  process.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error("invalid signature")));
  await expect(trustedCodexExecutable("/usr/local/bin/codex")).resolves.toBeUndefined();
  expect(process.execFile).toHaveBeenCalledWith("/usr/bin/codesign", ["--verify", "--strict",
    expect.stringMatching(/@openai\/codex-(?:darwin-arm64|darwin-x64)\/vendor\/.*\/codex\/codex$/)],
  expect.objectContaining({ timeout: 5_000 }), expect.any(Function));
  await expect(trustedCodexExecutable("/usr/local/bin/codex")).resolves.toBeUndefined();
  expect(process.execFile).toHaveBeenCalledTimes(1);
});

it("accepts a repaired installation and rejects unknown JavaScript launchers", async () => {
  files.realpath.mockResolvedValueOnce("/tmp/valid-b/@openai/codex/bin/codex.js");
  process.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  await expect(trustedCodexExecutable("/tmp/valid-b/codex")).resolves.toMatch(/\/codex\/codex$/);
  files.realpath.mockResolvedValueOnce("/tmp/untrusted/codex.js");
  await expect(trustedCodexExecutable("/tmp/untrusted/codex")).resolves.toBeUndefined();
  expect(process.execFile).toHaveBeenCalledTimes(1);
});

it("verifies the current desktop app's native Codex behind its shell launcher", async () => {
  files.realpath.mockResolvedValue("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  process.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error("invalid signature")));
  await expect(trustedCodexExecutable("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")).resolves.toBeUndefined();
  expect(process.execFile).toHaveBeenCalledWith("/usr/bin/codesign", ["--verify", "--strict",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"],
  expect.any(Object), expect.any(Function));
});
