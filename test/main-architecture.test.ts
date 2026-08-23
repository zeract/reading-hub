import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function mainFile(name: string): string {
  return readFileSync(resolve(process.cwd(), "src/main", name), "utf8");
}

function scriptFile(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), "scripts", ...parts), "utf8");
}

describe("main-process boundaries", () => {
  it("keeps Electron lifecycle, service composition, and IPC routing separate", () => {
    const index = mainFile("index.ts");
    const services = mainFile("app-services.ts");
    const handlers = mainFile("ipc-handlers.ts");

    expect(index).toContain("createApplicationServices");
    expect(index).toContain("registerIpcHandlers");
    expect(index).not.toContain("ipcMain.handle");
    expect(index).not.toContain("new ReadingDatabase");
    expect(services).toContain("createConnectorRegistry");
    expect(handlers).toContain("IPC_CHANNELS");
    expect(handlers).toContain("parseSourceSettings");
    expect(handlers).toContain("parseAiStreamRequest");
  });

  it("keeps services alive through the renderer shutdown drain before closing SQLite", () => {
    const index = mainFile("index.ts");

    expect(index).toMatch(/app\.on\("before-quit", \(\) => \{\s+quitting = true;\s+\}\);/);
    expect(index).toContain('app.once("will-quit", closeApplicationServices);');
    expect(index).not.toMatch(/app\.on\("before-quit", \(\) => \{[\s\S]*?services\?\.close\(\)/);
  });

  it("uses direct built-in connector adapters and a marker-gated maintenance path", () => {
    const registry = mainFile("connector-registry.ts");
    const services = mainFile("app-services.ts");
    const sync = mainFile("sync-manager.ts");

    expect(registry).not.toContain("LegacyConnectorAdapter");
    expect(registry).not.toContain("CallbackConnectorAdapter");
    expect(services).not.toContain("LegacyConnectorAdapter");
    expect(sync).toContain("maintenance?.prepareForSync");
    expect(sync).toContain("maintenance?.afterSuccessfulSync");
    expect(sync).not.toContain("repairScourRedirectEntries");
    expect(sync).not.toContain("deleteTaxonomyEntries");
  });

  it("keeps maintenance refresh on the same direct generic adapter as the app", () => {
    const refreshScript = scriptFile("source-refresh-app", "main.cjs");

    expect(refreshScript).toContain("registry.register(generic)");
    expect(refreshScript).not.toContain("LegacyConnectorAdapter");
    expect(refreshScript).not.toContain("CallbackConnectorAdapter");
    expect(refreshScript).not.toContain("SourceProbe");
  });
});
