import { defineConfig } from "vitest/config";
import { deferredModuleUrl } from "./scripts/deferred-module-plugin";

export default defineConfig({
  plugins: [deferredModuleUrl()],
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"]
  }
});
