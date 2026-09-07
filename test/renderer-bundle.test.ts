import { expect, it } from "vitest";
import { build, createServer } from "vite";
import type { OutputChunk } from "rollup";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";

const markdownPath = fileURLToPath(new URL("../src/renderer/ai-markdown.tsx", import.meta.url));

it("keeps AI answer parsing and KaTeX out of the renderer's initial module graph", async () => {
  const chunks = new Map<string, OutputChunk>();
  await build({ logLevel: "silent", build: { write: false }, plugins: [{
    name: "inspect-initial-renderer-dependencies",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) if (output.type === "chunk") chunks.set(output.fileName, output);
    }
  }] });
  const entry = [...chunks.values()].find((chunk) => chunk.facadeModuleId?.endsWith("/index.html"))!;
  expect(entry).toBeDefined();
  const initial = new Set<string>();
  const visit = (file: string) => {
    if (initial.has(file)) return;
    initial.add(file);
    chunks.get(file)?.imports.forEach(visit);
  };
  visit(entry.fileName);
  const eagerModules = [...initial].flatMap((file) => Object.keys(chunks.get(file)!.modules));
  // KaTeX CSS remains eager because main-process-rendered article formulas
  // need it before the optional AI parser is used.
  expect(eagerModules.some((id) => (id.includes("/katex/") && /\.[cm]?js(?:$|\?)/.test(id)) || id === markdownPath)).toBe(false);
  const deferred = [...chunks.values()].find((chunk) => Object.hasOwn(chunk.modules, markdownPath));
  expect(deferred).toBeDefined();
  expect(initial.has(deferred!.fileName)).toBe(false);
  expect([...initial].some((file) => chunks.get(file)!.referencedFiles.includes(deferred!.fileName))).toBe(true);
  // Retrying the optional module must not depend on another uncached optional
  // chunk whose failed URL would survive the retry.
  expect(deferred!.imports.every((file) => initial.has(file))).toBe(true);
});

it("serves a transpiled deferred module through the development URL", async () => {
  // Exercise URL resolution/transpilation without binding an HMR port or
  // starting a dependency optimizer that needs a live browser to finish.
  const server = await createServer({
    logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: { server: createHttpServer() }, preTransformRequests: false }
  });
  try {
    const reference = await server.transformRequest("/ai-markdown.tsx?chunk-url");
    const match = reference?.code.match(/export default ("[^"]+")/);
    expect(match).toBeTruthy();
    const url = JSON.parse(match![1]);
    const module = await server.transformRequest(url);
    expect(module?.code).toContain("AiMarkdownContent");
    expect(module?.code).not.toContain("type JSX");
  } finally { await server.close(); }
});
