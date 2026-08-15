import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const CODEX_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_LENGTH = 40_000;
const MAX_STDERR_LENGTH = 4_000;

export interface CodexCliStatus {
  available: boolean;
  command?: string;
}

/**
 * Boundary used by the reading assistant. The CLI retains responsibility for
 * its own ChatGPT authentication; Reading Hub never reads its config or token.
 */
export interface CodexCliRunner {
  status(): Promise<CodexCliStatus>;
  ask(instruction: string, articleContext: string): Promise<string>;
}

export class LocalCodexCli implements CodexCliRunner {
  async status(): Promise<CodexCliStatus> {
    const command = await findCodexCommand();
    return command ? { available: true, command } : { available: false };
  }

  async ask(instruction: string, articleContext: string): Promise<string> {
    const { command } = await this.status();
    if (!command) throw new CodexCliError("未检测到本机 Codex CLI。请安装 Codex CLI 并在终端运行 codex 完成登录后重试。");
    return runCodex(command, instruction, articleContext);
  }
}

export class CodexCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCliError";
  }
}

async function findCodexCommand(): Promise<string | undefined> {
  const namedCandidates = process.platform === "win32"
    ? ["codex.exe", "codex.cmd"]
    : ["codex"];
  const fixedCandidates = process.platform === "darwin" ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] : [];
  for (const candidate of fixedCandidates) {
    if (await executable(candidate)) return candidate;
  }
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    for (const name of namedCandidates) {
      const candidate = join(directory, name);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

async function executable(command: string): Promise<boolean> {
  try {
    await access(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCodex(command: string, instruction: string, articleContext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, codexExecArguments(instruction), {
      cwd: tmpdir(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CODEX_TIMEOUT_MS);
    const append = (current: string, chunk: Buffer, limit: number) => current.length >= limit
      ? current
      : `${current}${chunk.toString("utf8")}`.slice(0, limit);

    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, MAX_OUTPUT_LENGTH); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, MAX_STDERR_LENGTH); });
    child.stdin.once("error", () => undefined);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new CodexCliError("无法启动本机 Codex CLI。请重新安装后在终端执行 codex 登录。"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const answer = stdout.trim();
      if (timedOut) {
        reject(new CodexCliError("本机 Codex CLI 回答超时，请稍后重试。"));
      } else if (code === 0 && answer) {
        resolve(answer);
      } else {
        reject(new CodexCliError(codexFailureMessage(stderr)));
      }
    });
    child.stdin.end(articleContext);
  });
}

/** Keep the invocation auditable and free of broad-write or full-auto flags. */
export function codexExecArguments(instruction: string): string[] {
  return ["exec", "--ephemeral", "--sandbox", "read-only", instruction];
}

function codexFailureMessage(stderr: string): string {
  if (/login|sign in|authentication|auth/i.test(stderr)) {
    return "Codex CLI 尚未完成登录。请在终端运行 codex，并使用你的 ChatGPT 账户登录后重试。";
  }
  return "本机 Codex CLI 未能完成回答。请确认已登录，并在终端运行 codex exec 以查看详细诊断。";
}
