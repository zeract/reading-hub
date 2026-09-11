import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
for (const mode of ["idle", "busy", "unload", "startup"]) {
  await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), ["scripts/shutdown-smoke-app"], {
      stdio: "inherit", env: { ...process.env, READING_HUB_SHUTDOWN_CASE: mode }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Shutdown ${mode}: ${signal || code}`)));
  });
}
