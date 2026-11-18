import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { deferredModuleUrl } from "./scripts/deferred-module-plugin";

function diagramLicenses(): Plugin {
  return {
    name: "diagram-licenses",
    apply: "build",
    generateBundle() {
      const mermaid = new URL("./node_modules/beautiful-mermaid/package.json", import.meta.url);
      const require = createRequire(mermaid);
      const licenses = [
        ["beautiful-mermaid", "https://github.com/lukilabs/beautiful-mermaid", new URL("LICENSE", mermaid)],
        ["elkjs", "https://github.com/kieler/elkjs", resolve(dirname(require.resolve("elkjs/package.json")), "LICENSE.md")],
        ["entities", "https://github.com/fb55/entities", resolve(dirname(require.resolve("entities")), "../../LICENSE")]
      ] as const;
      this.emitFile({ type: "asset", fileName: "licenses/reader-diagrams.txt", source: licenses.map(
        ([name, source, license]) => name + " (" + source + ")\n\n" + readFileSync(license, "utf8")
      ).join("\n\n") });
    }
  };
}

export default defineConfig({
  plugins: [react(), deferredModuleUrl(), diagramLicenses()],
  root: "src/renderer",
  base: "./",
  // Native URL imports are outside Vite's dependency scan. Optimize their
  // libraries up front without eagerly loading AI rendering in the browser.
  optimizeDeps: { include: ["markdown-it", "katex"] },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  }
});
