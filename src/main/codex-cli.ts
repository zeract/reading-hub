import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AiReasoningEffort } from "../shared/types";
import { awaitWithAbort } from "./cancellation";

const CODEX_TIMEOUT_MS = 90_000;
const CODEX_EXTENDED_TIMEOUT_MS = 180_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
const APP_SERVER_IDLE_TIMEOUT_MS = 45_000;
/** Never free a cancelled turn's slot while the App Server may still run it. */
const APP_SERVER_INTERRUPT_DRAIN_TIMEOUT_MS = 15_000;
/** Small multiplexing window improves translation throughput without flooding the local account. */
const APP_SERVER_MAX_CONCURRENT_TURNS = 2;
const MAX_OUTPUT_LENGTH = 40_000;
const MAX_STDERR_LENGTH = 4_000;
const DESKTOP_CODEX_COMMAND = "/Applications/ChatGPT.app/Contents/Resources/codex";
const APP_SERVER_CLIENT_INFO = { name: "reading-hub", title: "Reading Hub", version: "0.1.0" };
/**
 * Provider settings and translation batches can ask for CLI status several
 * times in quick succession.  Keep command discovery short-lived: it avoids
 * repeatedly walking every PATH entry, while a newly installed or removed CLI
 * is still noticed on the next short polling window.
 */
export const CODEX_COMMAND_DISCOVERY_TTL_MS = 5_000;

/**
 * A small FIFO semaphore for the App Server bridge.  A release transfers its
 * permit directly to the oldest waiter instead of briefly returning it to the
 * pool.  That detail is important: otherwise a newly arriving request can
 * steal the permit between `release()` and the woken waiter's next microtask,
 * allowing the active turn count to exceed the configured limit.
 */
export class BoundedAsyncSemaphore {
  private available: number;
  private closedError: Error | undefined;
  private waiters: SemaphoreWaiter[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("BoundedAsyncSemaphore capacity must be a positive integer.");
    }
    this.available = capacity;
  }

  get activeCount(): number {
    return this.capacity - this.available;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(options: { signal?: AbortSignal; abortError?: () => Error } = {}): Promise<() => void> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (options.signal?.aborted) return Promise.reject(options.abortError?.() || new Error("Operation cancelled."));
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.createLease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve: (release) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(release);
        },
        reject: (error) => {
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        },
        signal: options.signal,
        abortError: options.abortError
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.reject(options.abortError?.() || new Error("Operation cancelled."));
      };
      if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Rejects queued callers without revoking slots that have already started. */
  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private createLease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    let waiter = this.waiters.shift();
    while (waiter) {
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.abortError?.() || new Error("Operation cancelled."));
        waiter = this.waiters.shift();
        continue;
      }
      // Keep `available` unchanged: this is an atomic ownership hand-off,
      // so a concurrent acquire must queue behind the already-reserved slot.
      waiter.resolve(this.createLease());
      return;
    }
    this.available = Math.min(this.capacity, this.available + 1);
  }
}

type SemaphoreWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortError?: () => Error;
};

type CachedCodexCommand = { command: string | undefined; expiresAt: number };

let cachedCodexCommand: CachedCodexCommand | undefined;
let pendingCodexCommandDiscovery: Promise<string | undefined> | undefined;
let codexCommandDiscoveryGeneration = 0;

export interface CodexCliStatus {
  available: boolean;
  command?: string;
}

export interface CodexCliOptions {
  /** Omit the model to let the user's local Codex keep its current default. */
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
  ask(instruction: string, articleContext: string, options: CodexCliOptions, signal?: AbortSignal): Promise<string>;
  /** The local Codex App Server exposes incremental agent-message events while a turn is running. */
  askStream?(instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener, signal?: AbortSignal): Promise<string>;
  /** Releases the local app-server bridge early when the host is shutting down. */
  dispose?(): void;
}

export class LocalCodexCli implements CodexCliRunner {
  private appServer: PersistentCodexAppServer | undefined;

  async status(): Promise<CodexCliStatus> {
    const command = await findCodexCommand();
    return command ? { available: true, command } : { available: false };
  }

  async ask(instruction: string, articleContext: string, options: CodexCliOptions, signal?: AbortSignal): Promise<string> {
    return this.askStream(instruction, articleContext, options, () => undefined, signal);
  }

  async askStream(instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener, signal?: AbortSignal): Promise<string> {
    throwIfCodexCancelled(signal);
    const { command } = await this.status();
    if (!command) throw new CodexCliError("未检测到本机 Codex。请安装官方 Codex，并在终端运行 codex 完成登录后重试。");
    try {
      return await this.getAppServer(command).ask(instruction, articleContext, options, onDelta, signal);
    } catch (error) {
      if (error instanceof CodexAppServerTransportError) this.dispose();
      // `exec --json` is not token-streaming, but it remains a compatibility
      // fallback for an older CLI that has not shipped app-server yet.
      if (error instanceof CodexAppServerUnavailableError) {
        this.dispose();
        return runCodexStream(command, instruction, articleContext, options, onDelta, signal);
      }
      throw error;
    }
  }

  dispose(): void {
    this.appServer?.dispose();
    this.appServer = undefined;
  }

  private getAppServer(command: string): PersistentCodexAppServer {
    if (this.appServer?.command === command && this.appServer.reusable) return this.appServer;
    this.dispose();
    this.appServer = new PersistentCodexAppServer(command);
    return this.appServer;
  }
}

export class CodexCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCliError";
  }
}

/** Keep local cancellation distinct from an App Server transport failure. */
export function throwIfCodexCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CodexCliError("AI 请求已取消。");
}

class CodexAppServerUnavailableError extends Error {
  constructor() {
    super("本机 Codex 不支持实时 App Server 协议。");
    this.name = "CodexAppServerUnavailableError";
  }
}

/** A disconnected initialized bridge can be recreated on the next question. */
class CodexAppServerTransportError extends Error {
  constructor() {
    super("本机 Codex App Server 已断开。");
    this.name = "CodexAppServerTransportError";
  }
}

/**
 * Shared, in-flight-aware command discovery used by every `status()` call.
 * Negative results are cached too, otherwise a missing executable makes each
 * render frame scan the entire PATH. Failures themselves are never cached.
 */
export async function findCodexCommand(): Promise<string | undefined> {
  const now = Date.now();
  if (cachedCodexCommand && cachedCodexCommand.expiresAt > now) return cachedCodexCommand.command;
  if (pendingCodexCommandDiscovery) return pendingCodexCommandDiscovery;

  const generation = codexCommandDiscoveryGeneration;
  const discovery = findCodexCommandUncached().then((command) => {
    // A caller may explicitly invalidate discovery while an old filesystem
    // scan is in flight. Do not let that older result revive a stale command.
    if (generation === codexCommandDiscoveryGeneration) {
      cachedCodexCommand = { command, expiresAt: Date.now() + CODEX_COMMAND_DISCOVERY_TTL_MS };
    }
    return command;
  });
  pendingCodexCommandDiscovery = discovery;
  void discovery.then(
    () => { if (pendingCodexCommandDiscovery === discovery) pendingCodexCommandDiscovery = undefined; },
    () => { if (pendingCodexCommandDiscovery === discovery) pendingCodexCommandDiscovery = undefined; }
  );
  return discovery;
}

/**
 * Allow the main-process boundary to discard a stale executable path after a
 * launch-level failure. It is also intentionally small enough for focused
 * lifecycle tests; no article text, auth state, or answer data is cached.
 */
export function invalidateCodexCommandDiscovery(): void {
  codexCommandDiscoveryGeneration += 1;
  cachedCodexCommand = undefined;
  pendingCodexCommandDiscovery = undefined;
}

async function findCodexCommandUncached(): Promise<string | undefined> {
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

/**
 * A single local JSON-RPC bridge is reused across questions. Each question
 * still receives a fresh ephemeral thread, which prevents one article's text
 * from becoming context for another, but avoids re-launching and re-signing
 * into Codex for every reader interaction.
 */
class PersistentCodexAppServer {
  readonly command: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private initialized = false;
  private disposed = false;
  private stdoutBuffer = "";
  private stderr = "";
  private nextRequestId = 0;
  private pending = new Map<number, PendingAppServerRequest>();
  private activeTurns = new Map<string, ActiveAppServerTurn>();
  /** A cancellation may arrive before turn/start returns its turn id. */
  private pendingInterrupts = new Set<string>();
  private turnSemaphore = new BoundedAsyncSemaphore(APP_SERVER_MAX_CONCURRENT_TURNS);
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(command: string) {
    this.command = command;
  }

  get reusable(): boolean {
    return !this.disposed;
  }

  async ask(instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener, signal?: AbortSignal): Promise<string> {
    throwIfCodexCancelled(signal);
    const releaseTurnSlot = await this.acquireTurnSlot(signal);
    this.clearIdleTimer();
    try {
      throwIfCodexCancelled(signal);
      await awaitWithAbort(this.ensureReady(), signal);
      // Cancellation can happen while the shared bridge initializes. Do not
      // create an otherwise orphaned ephemeral thread afterwards.
      throwIfCodexCancelled(signal);
      return await this.startEphemeralTurn(instruction, articleContext, options, onDelta, signal);
    } finally {
      releaseTurnSlot();
      this.scheduleIdleDispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    const failure = new CodexAppServerTransportError();
    this.turnSemaphore.close(failure);
    this.failAll(failure);
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }

  private acquireTurnSlot(signal?: AbortSignal): Promise<() => void> {
    if (this.disposed) throw new CodexAppServerTransportError();
    return this.turnSemaphore.acquire({ signal, abortError: () => new CodexCliError("AI 请求已取消。") });
  }

  private async ensureReady(): Promise<void> {
    if (this.disposed) throw new CodexAppServerTransportError();
    if (this.ready) return this.ready;

    const child = spawn(this.command, codexAppServerArguments(), {
      cwd: tmpdir(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    // The bridge must never keep the Electron process alive after its windows
    // have closed. Active Electron work keeps the stdio listeners serviced.
    child.unref();
    this.unrefStream(child.stdin);
    this.unrefStream(child.stdout);
    this.unrefStream(child.stderr);
    this.attachChild(child);
    this.ready = this.request("initialize", {
      clientInfo: APP_SERVER_CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false }
    }).then(() => {
      this.initialized = true;
      this.notify("initialized", {});
    }).catch((error: unknown) => {
      if (error instanceof CodexCliError) throw error;
      throw new CodexAppServerUnavailableError();
    });
    try {
      await this.ready;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private async startEphemeralTurn(instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener, signal?: AbortSignal): Promise<string> {
    throwIfCodexCancelled(signal);
    const threadResult = await awaitWithAbort(
      this.request("thread/start", codexAppServerThreadStartParameters(instruction)),
      signal
    );
    // A request can be cancelled while thread/start is in flight. The thread
    // is ephemeral, but never start a model turn after the caller has gone.
    throwIfCodexCancelled(signal);
    const threadId = appServerThreadId(threadResult);
    if (!threadId) throw new CodexCliError("本机 Codex App Server 返回的会话无效，请更新本机 Codex 后重试。");

    return new Promise<string>((resolve, reject) => {
      let turnStartIssued = false;
      const timeout = setTimeout(() => {
        if (turnStartIssued) this.beginTurnDrain(threadId, new CodexCliError("本机 Codex 回答超时，请稍后重试。"));
      }, codexTimeout(options));
      const abort = () => {
        if (turnStartIssued) this.beginTurnDrain(threadId, new CodexCliError("AI 请求已取消。"));
      };
      const abortListener = () => abort();
      this.activeTurns.set(threadId, { answer: "", onDelta, resolve, reject, timeout, abortSignal: signal, abortListener });
      if (signal?.aborted) {
        // No turn/start request has been issued yet, so there is no remote
        // model work to drain. Settle immediately instead of retaining this
        // semaphore lease forever.
        this.finishTurn(threadId, { error: new CodexCliError("AI 请求已取消。") });
        return;
      }
      signal?.addEventListener("abort", abortListener, { once: true });
      turnStartIssued = true;
      void this.request("turn/start", codexAppServerTurnStartParameters(threadId, articleContext, options)).then((turnResult) => {
        const turn = this.activeTurns.get(threadId);
        const turnId = appServerTurnId(turnResult);
        if (turn) turn.turnId = turnId;
        if (turnId && this.pendingInterrupts.delete(threadId)) this.requestTurnInterrupt(threadId, turnId);
      }).catch((error: unknown) => {
        const turn = this.activeTurns.get(threadId);
        // A transport timeout occurs after JSON-RPC was written to stdin, so
        // the App Server may still create the turn after our local request
        // expires. Do not release this turn's semaphore lease into a new
        // model request. Killing the shared bridge is the only safe way to
        // discard an unconfirmed turn (and it also handles a pending abort
        // whose interrupt cannot yet name a turn id).
        if (turn?.draining || error instanceof CodexAppServerTransportError) {
          this.dispose();
          return;
        }
        this.pendingInterrupts.delete(threadId);
        this.finishTurn(threadId, { error: turn?.drainError || asCodexError(error, this.stderr) });
      });
    });
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.stdoutBuffer.length >= MAX_OUTPUT_LENGTH * 2) return;
      this.stdoutBuffer = `${this.stdoutBuffer}${chunk.toString("utf8")}`.slice(0, MAX_OUTPUT_LENGTH * 2);
      this.consumeLines();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendText(this.stderr, chunk, MAX_STDERR_LENGTH);
    });
    child.stdin.once("error", () => this.handleDisconnect());
    child.once("error", () => this.handleDisconnect());
    child.once("close", () => {
      this.consumeLines(true);
      this.handleDisconnect();
    });
  }

  private consumeLines(flush = false): void {
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.acceptMessage(JSON.parse(line));
      } catch {
        // Never let diagnostics or malformed protocol lines reach the reader.
      }
    }
  }

  private acceptMessage(message: unknown): void {
    if (!isRecord(message) || this.disposed) return;
    // App-server can issue its own JSON-RPC requests (for example, a tool
    // approval). They are not responses to our request IDs and must never be
    // mistaken for one; this client grants no approvals or tools.
    const responseId = typeof message.id === "number" && typeof message.method !== "string" ? message.id : undefined;
    if (responseId !== undefined) {
      const pending = this.pending.get(responseId);
      if (!pending) return;
      this.pending.delete(responseId);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(appServerResponseError(message.error, this.initialized, this.stderr));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = isRecord(message.params) ? message.params : undefined;
      const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      const turn = threadId ? this.activeTurns.get(threadId) : undefined;
      const delta = codexAppServerAgentDelta(message, threadId);
      if (turn && delta) this.appendTurnDelta(turn, delta);
      return;
    }
    if (message.method === "item/completed" && isRecord(message.params)) {
      const threadId = typeof message.params.threadId === "string" ? message.params.threadId : undefined;
      const item = isRecord(message.params.item) ? message.params.item : undefined;
      const turn = threadId ? this.activeTurns.get(threadId) : undefined;
      if (turn && item?.type === "agentMessage" && typeof item.text === "string") this.acceptTurnSnapshot(turn, item.text);
      return;
    }
    if (message.method === "turn/completed" && isRecord(message.params)) {
      const threadId = typeof message.params.threadId === "string" ? message.params.threadId : undefined;
      if (!threadId) return;
      const turn = this.activeTurns.get(threadId);
      if (!turn) return;
      const completed = isRecord(message.params.turn) ? message.params.turn : undefined;
      if (turn.draining || completed?.status !== "completed") {
        this.finishTurn(threadId, { error: turn.drainError || turnCompletionError(completed, this.stderr) });
      } else {
        const snapshot = appServerAgentMessageText(completed);
        if (snapshot) this.acceptTurnSnapshot(turn, snapshot);
        this.finishTurn(threadId, { answer: turn.answer.trim() });
      }
    }
  }

  private appendTurnDelta(turn: ActiveAppServerTurn, delta: string): void {
    if (turn.draining) return;
    const remaining = MAX_OUTPUT_LENGTH - turn.answer.length;
    if (remaining <= 0) return;
    const accepted = delta.slice(0, remaining);
    if (!accepted) return;
    turn.answer += accepted;
    turn.onDelta(accepted);
  }

  private acceptTurnSnapshot(turn: ActiveAppServerTurn, snapshot: string): void {
    if (turn.draining) return;
    if (!snapshot) return;
    if (!turn.answer) {
      this.appendTurnDelta(turn, snapshot);
      return;
    }
    if (snapshot.startsWith(turn.answer)) {
      this.appendTurnDelta(turn, snapshot.slice(turn.answer.length));
      return;
    }
    // A revised final message is authoritative. The renderer gets that value
    // in its completion event and never sees a duplicate interim paragraph.
    turn.answer = snapshot.slice(0, MAX_OUTPUT_LENGTH);
  }

  private finishTurn(threadId: string, result: { answer?: string; error?: Error }): void {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    this.activeTurns.delete(threadId);
    this.pendingInterrupts.delete(threadId);
    clearTimeout(turn.timeout);
    if (turn.drainTimeout) clearTimeout(turn.drainTimeout);
    turn.abortSignal?.removeEventListener("abort", turn.abortListener!);
    if (result.error) {
      turn.reject(result.error);
      return;
    }
    if (!result.answer) {
      turn.reject(new CodexCliError("本机 Codex 没有返回可显示的回答，请调整问题后重试。"));
      return;
    }
    turn.resolve(result.answer);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable || this.disposed) {
      return Promise.reject(this.initialized ? new CodexAppServerTransportError() : new CodexAppServerUnavailableError());
    }
    const id = ++this.nextRequestId;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(this.initialized ? new CodexAppServerTransportError() : new CodexAppServerUnavailableError());
      }, APP_SERVER_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(this.initialized ? new CodexAppServerTransportError() : new CodexAppServerUnavailableError());
      }
    });
  }

  /** Best-effort, stable App Server cancellation. Late events are ignored. */
  private requestTurnInterrupt(threadId: string, knownTurnId?: string): void {
    const turn = this.activeTurns.get(threadId);
    const turnId = knownTurnId || turn?.turnId;
    if (!turnId) {
      this.pendingInterrupts.add(threadId);
      return;
    }
    void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
  }

  /**
   * Keep a semaphore lease while a cancelled/expired server turn is draining.
   * Releasing it when merely sending `turn/interrupt` lets rapid tab switches
   * briefly run more model turns than the configured cap. If the App Server
   * cannot confirm completion in a bounded interval, dispose its bridge so no
   * hidden local turn is left consuming capacity.
   */
  private beginTurnDrain(threadId: string, error: CodexCliError): void {
    const turn = this.activeTurns.get(threadId);
    if (!turn || turn.draining) return;
    turn.draining = true;
    turn.drainError = error;
    turn.abortSignal?.removeEventListener("abort", turn.abortListener!);
    this.requestTurnInterrupt(threadId);
    turn.drainTimeout = setTimeout(() => {
      if (!this.activeTurns.has(threadId)) return;
      this.dispose();
    }, APP_SERVER_INTERRUPT_DRAIN_TIMEOUT_MS);
    turn.drainTimeout.unref();
  }

  /** JSON-RPC lifecycle acknowledgement; it has no response id and grants no capability. */
  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin.writable || this.disposed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.child = undefined;
    const failure = this.initialized ? new CodexAppServerTransportError() : new CodexAppServerUnavailableError();
    this.turnSemaphore.close(failure);
    this.failAll(failure);
  }

  private failAll(error: Error): void {
    this.pendingInterrupts.clear();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    for (const [threadId, turn] of this.activeTurns) this.finishTurn(threadId, { error: turn.drainError || error });
  }

  private scheduleIdleDispose(): void {
    if (this.disposed || this.activeTurns.size > 0 || this.turnSemaphore.activeCount > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.dispose(), APP_SERVER_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private unrefStream(stream: unknown): void {
    const handle = stream as { unref?: () => void };
    handle.unref?.();
  }
}

type PendingAppServerRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ActiveAppServerTurn = {
  answer: string;
  onDelta: CodexCliDeltaListener;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  turnId?: string;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  /** A cancelled turn remains active until the server confirms it stopped. */
  draining?: boolean;
  drainError?: CodexCliError;
  drainTimeout?: ReturnType<typeof setTimeout>;
};

/**
 * Compatibility path for older local Codex installations which do not expose `app-server`.
 * `exec --json` is structured, but may emit only a completed agent message;
 * only agent-message output is ever forwarded to the renderer.
 */
function runCodexStream(command: string, instruction: string, articleContext: string, options: CodexCliOptions, onDelta: CodexCliDeltaListener, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CodexCliError("AI 请求已取消。"));
      return;
    }
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
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      if (!child.killed) child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
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
      signal?.removeEventListener("abort", abort);
      reject(new CodexCliError("无法启动本机 Codex。请重新安装后在终端执行 codex 登录。"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      consumeLines(true);
      const finalAnswer = answer.trim();
      if (timedOut) {
        reject(new CodexCliError("本机 Codex 回答超时，请稍后重试。"));
      } else if (cancelled) {
        reject(new CodexCliError("AI 请求已取消。"));
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

/** Each reader request starts isolated, non-persistent Codex context. */
export function codexAppServerThreadStartParameters(instruction: string): Record<string, unknown> {
  return {
    cwd: tmpdir(),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    baseInstructions: appServerInstruction(instruction)
  };
}

/** The article is intentionally sent as ordinary turn input, never as a file. */
export function codexAppServerTurnStartParameters(threadId: string, articleContext: string, options: CodexCliOptions): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: articleContext, text_elements: [] }],
    ...(options.model ? { model: options.model } : {}),
    effort: options.effort
  };
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

function appServerThreadId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.thread)) return undefined;
  return typeof result.thread.id === "string" ? result.thread.id : undefined;
}

function appServerTurnId(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.turn)) return undefined;
  return typeof result.turn.id === "string" ? result.turn.id : undefined;
}

function appServerAgentMessageText(turn: Record<string, unknown>): string | undefined {
  if (!Array.isArray(turn.items)) return undefined;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return undefined;
}

function appendText(current: string, chunk: Buffer, limit: number): string {
  return current.length >= limit ? current : `${current}${chunk.toString("utf8")}`.slice(0, limit);
}

function asCodexError(error: unknown, stderr: string): Error {
  return error instanceof Error ? error : new CodexCliError(codexFailureMessage(stderr));
}

function appServerResponseError(error: unknown, initialized: boolean, stderr: string): Error {
  const detail = isRecord(error) && typeof error.message === "string" ? `${stderr}\n${error.message}` : stderr;
  if (!initialized && /login|sign in|authentication|auth/i.test(detail)) return new CodexCliError(codexFailureMessage(detail));
  return initialized ? new CodexCliError(codexFailureMessage(detail)) : new CodexAppServerUnavailableError();
}

function turnCompletionError(turn: Record<string, unknown> | undefined, stderr: string): Error {
  const error = turn && isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : "";
  return new CodexCliError(codexFailureMessage(`${stderr}\n${error}`));
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
    return "本机 Codex 尚未完成登录。请在终端运行 codex，并使用你的 ChatGPT 账户登录后重试。";
  }
  if (/malicious software|contains malware|cannot be opened|can't be opened|Gatekeeper/i.test(stderr)) {
    return "macOS 已阻止本机 Codex。请从官方来源重新安装 Codex，然后在“系统设置 → 隐私与安全性”中检查并由你本人确认是否允许打开；Reading Hub 不会绕过 Gatekeeper。";
  }
  return "本机 Codex 未能完成回答。若 macOS 提示它包含恶意软件，请从官方来源重新安装，并在“系统设置 → 隐私与安全性”中由你本人确认是否允许打开；Reading Hub 不会绕过 Gatekeeper。";
}
