import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseDirectory = path.join(projectRoot, "release");

function value(environment, name) {
  const raw = environment[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * electron-builder accepts these three credential strategies. Keep the check
 * in this release wrapper so an absent or partially configured credential
 * never silently produces an unsigned, non-notarized DMG.
 */
export function notarizationStrategy(environment = process.env) {
  const apiKey = value(environment, "APPLE_API_KEY");
  const apiKeyId = value(environment, "APPLE_API_KEY_ID");
  const apiIssuer = value(environment, "APPLE_API_ISSUER");
  const appleId = value(environment, "APPLE_ID");
  const appPassword = value(environment, "APPLE_APP_SPECIFIC_PASSWORD");
  const teamId = value(environment, "APPLE_TEAM_ID");
  const keychainProfile = value(environment, "APPLE_KEYCHAIN_PROFILE");

  if (apiKey || apiKeyId || apiIssuer) {
    if (apiKey && apiKeyId && apiIssuer) return "api-key";
    throw new Error("公证凭证不完整：APPLE_API_KEY、APPLE_API_KEY_ID 与 APPLE_API_ISSUER 必须同时设置。");
  }
  if (appleId || appPassword || teamId) {
    if (appleId && appPassword && teamId) return "apple-id";
    throw new Error("公证凭证不完整：APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD 与 APPLE_TEAM_ID 必须同时设置。");
  }
  if (keychainProfile) return "keychain-profile";
  throw new Error("不能创建可公开分发的 DMG：请设置 Apple 公证凭证（推荐 APPLE_KEYCHAIN_PROFILE），详见 docs/macos-release.md。");
}

export function hasDeveloperIdIdentity(identityOutput, environment = process.env) {
  // CSC_LINK may point to a CI-provided .p12 that electron-builder imports
  // transiently, so it legitimately has no pre-existing Keychain identity.
  if (value(environment, "CSC_LINK")) return true;
  return /Developer ID Application:/i.test(identityOutput);
}

function run(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${argumentsList.join(" ")} 失败（退出码 ${code ?? "未知"}）。${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

async function filesRecursively(directory, predicate) {
  const matches = [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return matches;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (predicate(target, entry)) matches.push(target);
    if (entry.isDirectory() && !entry.name.endsWith(".app")) matches.push(...await filesRecursively(target, predicate));
  }
  return matches;
}

async function verifyArtifacts() {
  const apps = await filesRecursively(releaseDirectory, (target, entry) => entry.isDirectory() && target.endsWith(".app"));
  const dmgs = await filesRecursively(releaseDirectory, (target, entry) => entry.isFile() && target.endsWith(".dmg"));
  if (!apps.length || !dmgs.length) throw new Error("发布验证失败：release/ 中未找到 .app 或 .dmg 产物。");

  for (const appPath of apps) {
    await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    const signature = await run("codesign", ["-dv", "--verbose=4", appPath], { capture: true });
    if (!/Authority=Developer ID Application:/i.test(`${signature.stdout}\n${signature.stderr}`)) {
      throw new Error(`发布验证失败：${path.basename(appPath)} 未使用 Developer ID Application 签名。`);
    }
    await run("xcrun", ["stapler", "validate", appPath]);
    await run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  }
  for (const dmgPath of dmgs) await run("hdiutil", ["verify", dmgPath]);
}

export async function releaseMacApp({ verifyOnly = false } = {}) {
  if (process.platform !== "darwin") throw new Error("macOS DMG 只能在 macOS 上创建和验证。");
  notarizationStrategy();
  const identities = await run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
  if (!hasDeveloperIdIdentity(`${identities.stdout}\n${identities.stderr}`)) {
    throw new Error("未找到 Developer ID Application 证书。请先导入证书，或在 CI 中设置 CSC_LINK；详见 docs/macos-release.md。");
  }
  if (!verifyOnly) {
    await run("npm", ["run", "build"]);
    await run(path.join(projectRoot, "node_modules", ".bin", "electron-builder"), ["--mac"]);
  }
  await verifyArtifacts();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  const verifyOnly = process.argv.slice(2).includes("--verify-only");
  releaseMacApp({ verifyOnly }).then(() => {
    console.log("macOS 发布验证通过：可分发 DMG 位于 release/。");
  }).catch((error) => {
    console.error(`macOS 发布已停止：${error instanceof Error ? error.message : "未知错误"}`);
    process.exitCode = 1;
  });
}
