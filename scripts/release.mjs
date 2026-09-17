import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseDirectory = path.join(projectRoot, "release");
const localReleaseDirectory = path.join(releaseDirectory, "local");
let appPackagePromise;

function value(environment, name) {
  const raw = environment[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * electron-builder accepts these three credential strategies. The strict
 * release command uses this to prevent an absent or partial credential from
 * producing something that is presented as a public release.
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

/**
 * Choose the only two supported packaging modes. A local package is not a
 * degraded public release: it is built with signing and notarization disabled,
 * labelled as such, and kept out of the public release output area.
 */
export function distributionPlan(identityOutput, environment = process.env) {
  const blockers = [];
  if (!hasDeveloperIdIdentity(identityOutput, environment)) {
    blockers.push("未找到 Developer ID Application 签名身份");
  }

  let strategy;
  try {
    strategy = notarizationStrategy(environment);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "缺少有效 Apple 公证凭证");
  }

  if (!blockers.length && strategy) {
    return { kind: "signed", notarization: strategy, blockers: [] };
  }
  return { kind: "local-unsigned", notarization: undefined, blockers };
}

function timestampForPath(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function localUnsignedBuilderArguments(outputDirectory) {
  const relativeOutputDirectory = path.relative(projectRoot, outputDirectory);
  return [
    "--mac",
    "--config.forceCodeSigning=false",
    "--config.mac.identity=null",
    "--config.mac.notarize=false",
    "--config.dmg.title=Reading Hub (Local Unsigned)",
    "--config.dmg.artifactName=${productName}-${version}-${arch}-local-unsigned.${ext}",
    `--config.directories.output=${relativeOutputDirectory}`
  ];
}

export function localUnsignedEnvironment(environment = process.env) {
  const localEnvironment = {
    ...environment,
    // The config also sets identity=null. This prevents an identity that was
    // installed after the last build from changing a local package's status.
    CSC_IDENTITY_AUTO_DISCOVERY: "false"
  };
  for (const name of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "CSC_KEYCHAIN",
    "CSC_INSTALLER_LINK",
    "CSC_INSTALLER_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE"
  ]) {
    delete localEnvironment[name];
  }
  return localEnvironment;
}

function run(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      env: options.environment ?? process.env,
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
      const result = { stdout, stderr, code };
      if (code === 0 || options.allowFailure) {
        resolve(result);
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
    if (entry.isDirectory() && !entry.name.endsWith(".app")) {
      matches.push(...await filesRecursively(target, predicate));
    }
  }
  return matches;
}

async function appPackage() {
  appPackagePromise ??= readFile(path.join(projectRoot, "package.json"), "utf8").then((contents) => {
    return appPackageIdentity(JSON.parse(contents));
  });
  return appPackagePromise;
}

export function appPackageIdentity(manifest) {
  const productName = manifest?.build?.productName ?? manifest?.productName;
  if (typeof productName !== "string" || typeof manifest?.version !== "string") {
    throw new Error("发布验证失败：package.json 缺少 productName 或 version。");
  }
  return { productName, version: manifest.version };
}

async function existingPaths(candidates, expectedKind) {
  const existing = [];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if ((expectedKind === "file" && details.isFile()) || (expectedKind === "directory" && details.isDirectory())) {
        existing.push(candidate);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  }
  return existing;
}

export function publicArtifactCandidates({ productName, version }, architecture = process.arch) {
  const suffixes = architecture === "x64" ? ["", "-x64"] : [`-${architecture}`, ""];
  return [...new Set(suffixes)].map((suffix) => `${productName}-${version}${suffix}.dmg`);
}

async function currentSignedArtifacts() {
  const manifest = await appPackage();
  const dmgs = await existingPaths(
    publicArtifactCandidates(manifest).map((name) => path.join(releaseDirectory, name)),
    "file"
  );
  const appDirectories = [...new Set([`mac-${process.arch}`, "mac"])]
    .map((directory) => path.join(releaseDirectory, directory, `${manifest.productName}.app`));
  const apps = await existingPaths(appDirectories, "directory");
  if (!apps.length || !dmgs.length) {
    throw new Error(
      `发布验证失败：release/ 中未找到当前 ${manifest.version} / ${process.arch} 构建的 .app 或 .dmg 产物。`
    );
  }
  return { apps, dmgs };
}

async function releaseArtifacts(directory) {
  const apps = await filesRecursively(directory, (target, entry) => entry.isDirectory() && target.endsWith(".app"));
  const dmgs = await filesRecursively(directory, (target, entry) => entry.isFile() && target.endsWith(".dmg"));
  if (!apps.length || !dmgs.length) {
    throw new Error(`发布验证失败：${path.relative(projectRoot, directory) || "."}/ 中未找到 .app 或 .dmg 产物。`);
  }
  return { apps, dmgs };
}

async function verifySignedArtifacts() {
  // Only inspect the current version and architecture. release/ is a user
  // visible archive, so prior DMGs must not make a new release pass or fail.
  const { apps, dmgs } = await currentSignedArtifacts();

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

async function verifyLocalUnsignedArtifacts(outputDirectory) {
  const { apps, dmgs } = await releaseArtifacts(outputDirectory);
  for (const appPath of apps) {
    const signature = await run("codesign", ["-dv", "--verbose=4", appPath], {
      capture: true,
      allowFailure: true
    });
    const details = `${signature.stdout}\n${signature.stderr}`;
    if (/Authority=/i.test(details)) {
      throw new Error(`本地测试包验证失败：${path.basename(appPath)} 意外包含签名链。`);
    }
  }
  for (const dmgPath of dmgs) {
    if (!/-local-unsigned\.dmg$/i.test(path.basename(dmgPath))) {
      throw new Error(`本地测试包验证失败：${path.basename(dmgPath)} 缺少 local-unsigned 标识。`);
    }
    await run("hdiutil", ["verify", dmgPath]);
  }
}

async function codeSigningIdentities() {
  try {
    const identities = await run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
    return { output: `${identities.stdout}\n${identities.stderr}`, error: undefined };
  } catch (error) {
    return {
      output: "",
      error: error instanceof Error ? "无法读取 macOS 钥匙串中的签名身份" : "无法读取 macOS 签名身份"
    };
  }
}

export async function releaseMacApp({ verifyOnly = false, requireSigned = false } = {}) {
  if (process.platform !== "darwin") throw new Error("macOS DMG 只能在 macOS 上创建和验证。");
  const identities = await codeSigningIdentities();
  const plan = distributionPlan(identities.output, process.env);
  if (identities.error) plan.blockers.unshift(identities.error);

  if (requireSigned && plan.kind !== "signed") {
    const blockerMessage = plan.blockers.join("；").replace(/[；。\s]+$/, "");
    throw new Error(
      `无法创建可公开分发的 DMG：${blockerMessage}。` +
      "请导入 Developer ID Application 证书并配置 Apple 公证凭证；仅需本机测试时可使用 npm run dist。详见 docs/macos-release.md。"
    );
  }

  if (plan.kind === "signed") {
    if (!verifyOnly) {
      await run("npm", ["run", "build"]);
      await run(path.join(projectRoot, "node_modules", ".bin", "electron-builder"), ["--mac"]);
    }
    await verifySignedArtifacts();
    return { kind: "signed", outputDirectory: releaseDirectory };
  }

  if (verifyOnly) {
    throw new Error("本地未签名包不支持正式发布验证；请使用 npm run dist:release 与 npm run verify:macos-release。");
  }

  const outputDirectory = path.join(localReleaseDirectory, timestampForPath());
  console.warn(
    "未检测到完整的 Developer ID 签名与 Apple 公证配置；将创建仅供本机测试的未签名 DMG。" +
    "该包不能作为公开发布或升级安装包分发。"
  );
  await run("npm", ["run", "build"]);
  await run(
    path.join(projectRoot, "node_modules", ".bin", "electron-builder"),
    localUnsignedBuilderArguments(outputDirectory),
    { environment: localUnsignedEnvironment() }
  );
  await verifyLocalUnsignedArtifacts(outputDirectory);
  return { kind: "local-unsigned", outputDirectory };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  const verifyOnly = process.argv.slice(2).includes("--verify-only");
  const requireSigned = process.argv.slice(2).includes("--release") || verifyOnly;
  releaseMacApp({ verifyOnly, requireSigned }).then((result) => {
    if (result.kind === "signed") {
      console.log("macOS 正式发布验证通过：可分发 DMG 位于 release/。");
      return;
    }
    console.log(`本地未签名 DMG 已生成：${path.relative(projectRoot, result.outputDirectory)}/`);
  }).catch((error) => {
    console.error(`macOS 发布已停止：${error instanceof Error ? error.message : "未知错误"}`);
    process.exitCode = 1;
  });
}
