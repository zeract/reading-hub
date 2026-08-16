import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AiReasoningEffort } from "../shared/types";

const CODEX_TIMEOUT_MS = 90_000;
const CODEX_EXTENDED_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_LENGTH = 40_000;
const MAX_STDERR_LENGTH = 4_000;
const DESKTOP_CODEX_COMMAND = "/Applications/ChatGPT.app/Contents/Resources/codex";

export interface CodexCliStatus {
  available: boolean;
  command?: string;
}

export interface CodexCliOptions {
  /** Omit the model to let the user's Codex CLI keep its current default. */
  model?: string;
  effort: AiReasoningEffort;
}

export type CodexCliDeltaListener = (text: string) => void;

/**
 * Boundary used by the reading assistant. The CLI retains responsibility for
 * its own ChatGPT authentication; Reading Hub never reads its config or token.
 */
export interface CodexCliRunner {
  status(): Promise<CodexCliStatus>;
  ask(instruction: string, articleContext: string, options: CodexCliOptions): Promise<string>;
  /** Newer Codex CLIs expose structured JSONL events while a turn is running. */
  askStream?(instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener): Promise<string>;
}

export class LocalCodexCli implements CodexCliRunner {
  async status(): Promise<CodexCliStatus> {
    const command = await findCodexCommand();
    return command ? { available: true, command } : { available: false };
  }

  async ask(instruction: string, articleContext: string, options: CodexCliOptions): Promise<string> {
    const { command } = await this.status();
    if (!command) throw new CodexCliError("未检测到本机 Codex CLI。请安装 Codex CLI 并在终端运行 codex 完成登录后重试。");
    return runCodex(command, instruction, articleContext, options);
  }

  async askStream(instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener): Promise<string> {
    const { command } = await this.status();
    if (!command) throw new CodexCliError("未检测到本机 Codex CLI。请安装 Codex CLI 并在终端运行 codex 完成登录后重试。");
    return runCodexStream(command, instruction, articleContext, options, onDelta);
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
  // The desktop app ships a signed Codex executable. Prefer it on macOS so a
  // user's existing Codex session works without invoking an old npm binary
  // whose certificate may have been revoked by Gatekeeper.
  const desktopCandidates = process.platform === "darwin" ? [DESKTOP_CODEX_COMMAND] : [];
  // A user-installed official CLI is preferred over a stale system-global
  // copy. This avoids requiring sudo merely to replace a Gatekeeper-revoked
  // global binary and keeps Reading Hub within the user's own permissions.
  const userCandidates = process.platform === "darwin" ? [join(homedir(), ".local", "bin", "codex")] : [];
  const fixedCandidates = process.platform === "darwin" ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] : [];
  for (const candidate of [...desktopCandidates, ...userCandidates, ...fixedCandidates]) {
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

function runCodex(command: string, instruction: string, articleContext: string, options: CodexCliOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, codexExecArguments(instruction, options), {
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
    }, options.effort === "high" || options.effort === "xhigh" || options.effort === "max" ? CODEX_EXTENDED_TIMEOUT_MS : CODEX_TIMEOUT_MS);
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

/**
 * `codex exec --json` emits newline-delimited, structured progress events.
 * Only agent-message events are ever forwarded to the renderer: tool output,
 * paths and diagnostic events remain local to this process.
 */
function runCodexStream(command: string, instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, codexExecArguments(instruction, options, true), {
      cwd: tmpdir(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let answer = "";
    let eventBuffer = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.effort === "high" || options.effort === "xhigh" || options.effort === "max" ? CODEX_EXTENDED_TIMEOUT_MS : CODEX_TIMEOUT_MS);
    const append = (current: string, chunk: Buffer, limit: number) => current.length >= limit
      ? current
      : `${current}${chunk.toString("utf8")}`.slice(0, limit);
    const acceptEvent = (line: string) => {
      const event = parseCodexEvent(line);
      if (!event) return;
      const next = mergeCodexAnswer(answer, event);
      if (!next.delta) return;
      answer = next.answer;
      onDelta(next.delta);
    };
    const consumeLines = (flush = false) => {
      const lines = eventBuffer.split(/\r?\n/);
      if (flush) eventBuffer = "";
      else eventBuffer = lines.pop() || "";
      for (const line of lines) acceptEvent(line);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (eventBuffer.length >= MAX_OUTPUT_LENGTH) return;
      eventBuffer = `${eventBuffer}${chunk.toString("utf8")}`.slice(0, MAX_OUTPUT_LENGTH);
      consumeLines();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, MAX_STDERR_LENGTH); });
    child.stdin.once("error", () => undefined);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new CodexCliError("无法启动本机 Codex CLI。请重新安装后在终端执行 codex 登录。"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      consumeLines(true);
      const finalAnswer = answer.trim();
      if (timedOut) {
        reject(new CodexCliError("本机 Codex CLI 回答超时，请稍后重试。"));
      } else if (code === 0 && finalAnswer) {
        resolve(finalAnswer);
      } else {
        reject(new CodexCliError(codexFailureMessage(stderr)));
      }
    });
    child.stdin.end(articleContext);
  });
}

/** Keep the invocation auditable and free of broad-write or full-auto flags. */
export function codexExecArguments(instruction: string, options: CodexCliOptions = { effort: "medium" }, jsonEvents = false): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    ...(options.model ? ["--model", options.model] : []),
    "--config",
    `model_reasoning_effort=${options.effort}`,
    ...(jsonEvents ? ["--json"] : []),
    instruction
  ];
}

type CodexMessageEvent = { text: string; snapshot: boolean };

function parseCodexEvent(line: string): CodexMessageEvent | undefined {
  if (!line.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const eventType = typeof value.type === "string" ? value.type : "";
  const item = isRecord(value.item) ? value.item : undefined;
  // Codex's documented JSONL mode labels final assistant output as an
  // `agent_message` item. Deliberately reject every other item kind.
  if (item?.type === "agent_message") {
    const text = stringField(item, ["text", "content"]);
    if (text) return { text, snapshot: !eventType.endsWith(".delta") };
  }
  if (/agent_message.*\.delta/i.test(eventType)) {
    const text = stringField(value, ["delta", "text"]);
    if (text) return { text, snapshot: false };
  }
  return undefined;
}

function mergeCodexAnswer(answer: string, event: CodexMessageEvent): { answer: string; delta: string } {
  if (!event.snapshot) return { answer: `${answer}${event.text}`.slice(0, MAX_OUTPUT_LENGTH), delta: event.text };
  if (event.text === answer || answer.endsWith(event.text)) return { answer, delta: "" };
  if (event.text.startsWith(answer)) return { answer: event.text.slice(0, MAX_OUTPUT_LENGTH), delta: event.text.slice(answer.length) };
  // A completed agent-message item is normally the full answer. If the CLI
  // changed an earlier partial event, prefer its authoritative final text.
  if (!answer) return { answer: event.text.slice(0, MAX_OUTPUT_LENGTH), delta: event.text };
  return { answer: event.text.slice(0, MAX_OUTPUT_LENGTH), delta: event.text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function codexFailureMessage(stderr: string): string {
  if (/login|sign in|authentication|auth/i.test(stderr)) {
    return "Codex CLI 尚未完成登录。请在终端运行 codex，并使用你的 ChatGPT 账户登录后重试。";
  }
  if (/malicious software|contains malware|cannot be opened|can't be opened|Gatekeeper/i.test(stderr)) {
    return "macOS 已阻止本机 Codex CLI。请从官方来源重新安装 Codex CLI，然后在“系统设置 → 隐私与安全性”中检查并由你本人确认是否允许打开；Reading Hub 不会绕过 Gatekeeper。";
  }
  return "本机 Codex CLI 未能完成回答。若 macOS 提示它包含恶意软件，请从官方来源重新安装，并在“系统设置 → 隐私与安全性”中由你本人确认是否允许打开；Reading Hub 不会绕过 Gatekeeper。";
}
