import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { pruneMainOutput } from "../scripts/prune-main-output.mjs";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "reading-hub-output-"));
  await mkdir(join(directory, "src/main"), { recursive: true });
  await mkdir(join(directory, "dist/main/main"), { recursive: true });
  await writeFile(join(directory, "src/main/kept.ts"), "export const kept = true;");
  await writeFile(join(directory, "tsconfig.main.json"), JSON.stringify({
    compilerOptions: { rootDir: "src", outDir: "dist/main" }, files: ["src/main/kept.ts"]
  }));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("removes orphan compiler artifacts but preserves current outputs and unrelated files", async () => {
  const output = join(directory, "dist/main/main");
  for (const file of ["kept.js", "removed.js", "removed.js.map", "removed.d.ts", "notes.txt"]) await writeFile(join(output, file), file);
  expect(await pruneMainOutput(directory)).toBe(3);
  expect(await readFile(join(output, "kept.js"), "utf8")).toBe("kept.js");
  expect(await readFile(join(output, "notes.txt"), "utf8")).toBe("notes.txt");
  expect(await pruneMainOutput(directory)).toBe(0);
});

it("does not follow directory symlinks outside the compiler output", async () => {
  const outside = join(directory, "unrelated");
  await mkdir(outside); await writeFile(join(outside, "private.js"), "unchanged");
  await symlink(outside, join(directory, "dist/main/link"), "dir");
  expect(await pruneMainOutput(directory)).toBe(0);
  expect(await readFile(join(outside, "private.js"), "utf8")).toBe("unchanged");
});

it("rejects an output directory outside the explicit generated target", async () => {
  await writeFile(join(directory, "tsconfig.main.json"), JSON.stringify({ compilerOptions: { outDir: "src" }, files: ["src/main/kept.ts"] }));
  await expect(pruneMainOutput(directory)).rejects.toThrow("仅允许清理项目 dist/main");
  expect(await readFile(join(directory, "src/main/kept.ts"), "utf8")).toContain("kept");
});
