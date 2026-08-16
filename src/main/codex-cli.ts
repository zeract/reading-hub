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
const APP_SERVER_CLIENT_INFO = { name: "reading-hub", title: "Reading Hub", version: "0.1.0" };

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
  /** Newer Codex CLIs expose incremental agent-message events while a turn is running. */
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
    try {
      return await runCodexAppServerStream(command, instruction, articleContext, options, onDelta);
    } catch (error) {
      // `exec --json` is not token-streaming, but it remains a compatibility
      // fallback for an older CLI that has not shipped app-server yet.
      if (error instanceof CodexAppServerUnavailableError) return runCodexStream(command, instruction, articleContext, options, onDelta);
      throw error;
    }
  }
}

export class CodexCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCliError";
  }
}

class CodexAppServerUnavailableError extends Error {
  constructor() {
    super("本机 Codex CLI 不支持实时 app-server 协议。");
    this.name = "CodexAppServerUnavailableError";
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
    }, codexTimeout(options));
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
 * The app-server protocol emits `item/agentMessage/delta` notifications as
 * Codex produces text. Unlike `codex exec --json`, whose current JSONL output
 * can contain only the final `item.completed`, this path provides real-time
 * reader updates without giving the assistant workspace write access.
 */
function runCodexAppServerStream(command: string, instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, codexAppServerArguments(), {
      cwd: tmpdir(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let answer = "";
    let stdoutBuffer = "";
    let stderr = "";
    let threadId: string | undefined;
    let phase: "initialize" | "thread" | "turn" | "receiving" = "initialize";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, codexTimeout(options));
    const append = (current: string, chunk: Buffer, limit: number) => current.length >= limit
      ? current
      : `${current}${chunk.toString("utf8")}`.slice(0, limit);
    const settle = (result: { answer?: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
      if (result.error) reject(result.error);
      else resolve(result.answer || "");
    };
    const send = (id: number, method: string, params: Record<string, unknown>) => {
      if (!child.stdin.writable || settled) return;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    const appendDelta = (delta: string) => {
      const remaining = MAX_OUTPUT_LENGTH - answer.length;
      if (remaining <= 0) return;
      const accepted = delta.slice(0, remaining);
      if (!accepted) return;
      answer += accepted;
      onDelta(accepted);
    };
    const acceptSnapshot = (snapshot: string) => {
      if (!snapshot) return;
      if (!answer) {
        appendDelta(snapshot);
        return;
      }
      if (snapshot.startsWith(answer)) {
        appendDelta(snapshot.slice(answer.length));
        return;
      }
      // Do not briefly duplicate a revised final message in the UI. The
      // renderer receives the authoritative version in its completion event.
      answer = snapshot.slice(0, MAX_OUTPUT_LENGTH);
    };
    const startThread = () => {
      phase = "thread";
      send(2, "thread/start", {
        cwd: tmpdir(),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        baseInstructions: appServerInstruction(instruction)
      });
    };
    const startTurn = (id: string) => {
      threadId = id;
      phase = "turn";
      send(3, "turn/start", {
        threadId: id,
        input: [{ type: "text", text: articleContext, text_elements: [] }],
        ...(options.model ? { model: options.model } : {}),
        effort: options.effort
      });
    };
    const acceptMessage = (message: unknown) => {
      if (!isRecord(message) || settled) return;
      if ("error" in message && message.error) {
        const error = phase === "initialize" || phase === "thread"
          ? new CodexAppServerUnavailableError()
          : new CodexCliError(codexFailureMessage(stderr));
        settle({ error });
        return;
      }
      const responseId = message.id;
      if (responseId === 1 && isRecord(message.result)) {
        startThread();
        return;
      }
      if (responseId === 2 && isRecord(message.result)) {
        const thread = isRecord(message.result.thread) ? message.result.thread : undefined;
        if (typeof thread?.id !== "string") {
          settle({ error: new CodexAppServerUnavailableError() });
          return;
        }
        startTurn(thread.id);
        return;
      }
      if (responseId === 3 && isRecord(message.result)) {
        phase = "receiving";
        return;
      }
      if (message.method === "item/agentMessage/delta") {
        const delta = codexAppServerAgentDelta(message, threadId);
        if (delta) appendDelta(delta);
        return;
      }
      if (message.method === "item/completed" && isRecord(message.params)) {
        const item = isRecord(message.params.item) ? message.params.item : undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") acceptSnapshot(item.text);
        return;
      }
      if (message.method === "turn/completed" && isRecord(message.params) && message.params.threadId === threadId) {
        const finalAnswer = answer.trim();
        settle(finalAnswer ? { answer: finalAnswer } : { error: new CodexCliError("本机 Codex CLI 没有返回可显示的回答，请调整问题后重试。") });
      }
    };
    const consumeLines = (flush = false) => {
      const lines = stdoutBuffer.split(/\r?\n/);
      if (flush) stdoutBuffer = "";
      else stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          acceptMessage(JSON.parse(line));
        } catch {
          // App-server diagnostics cannot become model output.
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBuffer.length >= MAX_OUTPUT_LENGTH * 2) return;
      stdoutBuffer = `${stdoutBuffer}${chunk.toString("utf8")}`.slice(0, MAX_OUTPUT_LENGTH * 2);
      consumeLines();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, MAX_STDERR_LENGTH); });
    child.stdin.once("error", () => undefined);
    child.once("error", () => settle({ error: new CodexAppServerUnavailableError() }));
    child.once("close", () => {
      consumeLines(true);
      if (settled) return;
      if (timedOut) settle({ error: new CodexCliError("本机 Codex CLI 回答超时，请稍后重试。") });
      else if (phase === "initialize" || phase === "thread") settle({ error: new CodexAppServerUnavailableError() });
      else settle({ error: new CodexCliError(codexFailureMessage(stderr)) });
    });
    send(1, "initialize", {
      clientInfo: APP_SERVER_CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
  });
}

/**
 * Compatibility path for older Codex CLIs which do not expose `app-server`.
 * `exec --json` is structured, but may emit only a completed agent message;
 * only agent-message output is ever forwarded to the renderer.
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
    }, codexTimeout(options));
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

/** The local JSON-RPC endpoint delivers `item/agentMessage/delta` events. */
export function codexAppServerArguments(): string[] {
  return ["app-server", "--listen", "stdio://"];
}

/** Keep long reasoning modes useful without allowing a stalled CLI to hang forever. */
function codexTimeout(options: CodexCliOptions): number {
  return options.effort === "high" || options.effort === "xhigh" || options.effort === "max"
    ? CODEX_EXTENDED_TIMEOUT_MS
    : CODEX_TIMEOUT_MS;
}

/** App-server receives the article as a turn rather than stdin. */
function appServerInstruction(instruction: string): string {
  return `${instruction}\n你只能根据用户这一次发送的文章摘录和问题回答；不得调用工具、读取或写入文件、运行命令或访问网络。`;
}

/**
 * Extract one safe visible delta from an app-server notification. The renderer
 * never receives tool calls, paths, or any other protocol events.
 */
export function codexAppServerAgentDelta(message: unknown, expectedThreadId?: string): string | undefined {
  if (!isRecord(message) || message.method !== "item/agentMessage/delta" || !isRecord(message.params)) return undefined;
  if (expectedThreadId && message.params.threadId !== expectedThreadId) return undefined;
  return typeof message.params.delta === "string" ? message.params.delta : undefined;
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
