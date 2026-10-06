import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { deferredModuleUrl } from "./scripts/deferred-module-plugin";

export default defineConfig({
  plugins: [react(), deferredModuleUrl()],
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
