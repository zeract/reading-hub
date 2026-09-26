import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform } from "node:process";
import { basename, dirname, join } from "node:path";

const signatureCache = new Map<string, { size: number; mtimeMs: number; checkedAt: number; trusted: boolean }>();
const SIGNATURE_RECHECK_MS = 5 * 60_000;

/** Resolve only a verified native payload; never execute an unchecked launcher script. */
export async function trustedCodexExecutable(command: string): Promise<string | undefined> {
  if (platform !== "darwin") return command;
  try {
    const resolved = await realpath(command);
    let native = resolved;
    if (resolved === "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex") {
      native = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    } else if (basename(resolved) === "codex.js") {
      const packageRoot = dirname(dirname(resolved));
      const target = arch === "arm64" ? "aarch64-apple-darwin" : arch === "x64" ? "x86_64-apple-darwin" : undefined;
      if (!target || basename(packageRoot) !== "codex" || basename(dirname(packageRoot)) !== "@openai") return undefined;
      const platformPackage = arch === "arm64" ? "codex-darwin-arm64" : "codex-darwin-x64";
      const installed = join(packageRoot, "node_modules", "@openai", platformPackage, "vendor", target, "codex", "codex");
      const fallback = join(packageRoot, "vendor", target, "codex", "codex");
      native = await isExecutable(installed) ? installed : fallback;
    }
    if (!await isExecutable(native)) return undefined;
    const info = await stat(native);
    const cached = signatureCache.get(native);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs
      && Date.now() - cached.checkedAt < SIGNATURE_RECHECK_MS) return cached.trusted ? native : undefined;
    const trusted = await verifySignature(native);
    signatureCache.set(native, { size: info.size, mtimeMs: info.mtimeMs, checkedAt: Date.now(), trusted });
    return trusted ? native : undefined;
  } catch {
    // An unknown shim or unavailable verification is not permission to launch.
    return undefined;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try { await access(file, constants.X_OK); return true; } catch { return false; }
}

function verifySignature(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 5_000, windowsHide: true }, (error) => resolve(!error));
  });
}
