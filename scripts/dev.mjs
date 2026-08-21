import { spawn } from "node:child_process";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer, connect } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devLockPath = path.join(projectRoot, ".reading-hub-dev.lock");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const host = "127.0.0.1";
const startedAt = Date.now();
const children = [];
let stopping = false;
let devLockToken;

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

async function releaseDevLock() {
  if (!devLockToken) return;
  try {
    if (await readFile(devLockPath, "utf8") === devLockToken) await unlink(devLockPath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      console.warn(`无法清理开发锁：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  devLockToken = undefined;
}

async function acquireDevLock() {
  devLockToken = `${process.pid}:${startedAt}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(devLockPath, "wx");
      await file.writeFile(devLockToken, "utf8");
      await file.close();
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const lock = await readFile(devLockPath, "utf8").catch(() => "");
      const ownerPid = Number.parseInt(lock.split(":", 1)[0] ?? "", 10);
      if (isProcessRunning(ownerPid)) {
        throw new Error(`Reading Hub 开发服务已在运行（PID ${ownerPid}）。请复用现有终端；停止它后再重新执行 npm run dev。`);
      }
      // A terminated shell can leave its tiny PID lock behind. It is safe to
      // replace only that stale, project-local lock and retry the atomic open.
      await unlink(devLockPath).catch((unlinkError) => {
        if (!(unlinkError && typeof unlinkError === "object" && "code" in unlinkError && unlinkError.code === "ENOENT")) throw unlinkError;
      });
    }
  }
  throw new Error("无法获取 Reading Hub 开发锁，请稍后重试。");
}

function bin(modulePath) {
  return path.join(projectRoot, "node_modules", ...modulePath.split("/"));
}

function launch(label, command, args, environment = {}, { restartable = false, ipc = false } = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
    // Electron receives a Node IPC channel only in development. Its main
    // process uses closure of this channel to quit when this supervisor dies.
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit"
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!stopping && !restartable && (code !== 0 || signal)) stop(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`${label} 无法启动：${error.message}`);
    stop(1);
  });
  return child;
}

function launchNode(label, script, args, environment = {}, options = {}) {
  return launch(label, process.execPath, [script, ...args], environment, options);
}

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法选择本地开发端口。"));
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function waitUntilReady(port, entryPaths) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const entries = await Promise.all(entryPaths.map((entryPath) => stat(entryPath)));
      if (entries.every((entry) => entry.mtimeMs >= startedAt - 100) && await portIsOpen(port)) return;
    } catch {
      // The TypeScript watcher has not emitted the Electron main process and preload bridge yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("开发服务器或 Electron 主进程编译在 30 秒内没有就绪。");
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(childHasExited(child));
    const timeout = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    // The process could end between the first check and listener registration.
    if (childHasExited(child)) finish(true);
  });
}

async function terminateChild(child) {
  if (childHasExited(child) || !child.pid) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5_000)) return;
  if (childHasExited(child)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 1_000);
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(restartForceTimer);
  // Do not abandon the Electron main process immediately after signalling it.
  // Its shutdown path closes SQLite and its Chromium children. A bounded force
  // kill covers a wedged development build without making normal shutdowns
  // slow, and prevents a live process from being re-parented to launchd.
  await Promise.allSettled(children.map((child) => terminateChild(child)));
  await releaseDevLock();
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void stop(0));

const port = await findAvailablePort();
const rendererUrl = `http://${host}:${port}`;
const mainOutput = path.join(projectRoot, "dist", "main", "main");
const requiredOutputs = [path.join(mainOutput, "index.js"), path.join(mainOutput, "preload.js")];
let electronChild;
let restartPending = false;
let restartTimer;
let restartForceTimer;

function launchElectron() {
  // Spawn Electron itself rather than `electron/cli.js`. The CLI is a Node
  // wrapper which can leave its Electron child alive after a restart signal,
  // producing one extra window on every main-process recompilation.
  electronChild = launch(
    "Electron",
    electronBinary,
    ["."],
    { VITE_DEV_SERVER_URL: rendererUrl, READING_HUB_DEV_SUPERVISOR_IPC: "1" },
    { restartable: true, ipc: true }
  );
  electronChild.on("exit", (code, signal) => {
    // Closing the development window should also release its watchers and
    // project lock. During an automatic main-process rebuild restartPending
    // keeps the supervisor alive and launches exactly one replacement window.
    if (!stopping && !restartPending) stop(code ?? (signal ? 1 : 0));
  });
}

function restartElectron() {
  if (stopping || restartPending) return;
  restartPending = true;
  const previousElectron = electronChild;
  if (!previousElectron || previousElectron.exitCode !== null) {
    restartPending = false;
    launchElectron();
    return;
  }
  previousElectron.once("exit", () => {
    clearTimeout(restartForceTimer);
    restartPending = false;
    if (!stopping) launchElectron();
  });
  // New Electron builds explicitly translate SIGTERM to app.quit(). Keep a
  // bounded fallback for an already-running old build that only hides to tray.
  restartForceTimer = setTimeout(() => {
    if (!previousElectron.killed && previousElectron.exitCode === null) previousElectron.kill("SIGKILL");
  }, 5_000);
  previousElectron.kill("SIGTERM");
}

function watchMainProcessOutput() {
  watch(mainOutput, (_event, fileName) => {
    if (!fileName || !["index.js", "preload.js"].includes(String(fileName))) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restartElectron, 120);
  }).on("error", (error) => console.error(`无法监听主进程构建结果：${error.message}`));
}

try {
  await acquireDevLock();
  // Acquire the project lock before starting watchers. Otherwise a second
  // `npm run dev` can leave duplicate Vite/TypeScript children even though it
  // later refuses to start Electron.
  launchNode("Vite", bin("vite/bin/vite.js"), ["--host", host, "--port", String(port), "--strictPort"]);
  launchNode("TypeScript", bin("typescript/bin/tsc"), ["-p", "tsconfig.main.json", "--watch", "--preserveWatchOutput"]);
  await waitUntilReady(port, requiredOutputs);
  console.log(`Reading Hub 开发服务器：${rendererUrl}`);
  launchElectron();
  watchMainProcessOutput();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
