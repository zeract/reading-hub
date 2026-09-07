import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { deferredModuleUrl } from "./scripts/deferred-module-plugin";

export default defineConfig({
  plugins: [react(), deferredModuleUrl()],
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  }
});
