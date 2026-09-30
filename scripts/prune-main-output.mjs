import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Incremental tsc does not remove outputs for deleted source files. Prune
 * only orphan compiler artifacts so removed connectors cannot enter a DMG. */
export async function pruneMainOutput(root) {
  const configPath = path.join(root, "tsconfig.main.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error("无法读取主进程编译配置。");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) throw new Error("主进程编译配置无效。");
  const output = path.resolve(parsed.options.outDir ?? "");
  if (output !== path.join(root, "dist", "main")) throw new Error("仅允许清理项目 dist/main 中的编译产物。");
  for (const directory of [path.join(root, "dist"), output]) {
    try { if (!(await lstat(directory)).isDirectory()) throw new Error("编译产物目录不能是符号链接或文件。"); }
    catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  }
  const expected = new Set(parsed.fileNames.flatMap(file => ts.getOutputFileNames(parsed, file, false)).map(file => path.resolve(file)));
  let removed = 0;
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      // Never follow symlinks or remove non-compiler files.
      else if (entry.isFile() && /\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(entry.name) && !expected.has(file)) {
        await unlink(file); removed += 1;
      }
    }
  }
  await visit(output);
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const removed = await pruneMainOutput(root);
  if (removed) console.info(`已清理 ${removed} 个无对应源码的旧编译产物。`);
}
