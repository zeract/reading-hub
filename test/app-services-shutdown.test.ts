import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ BrowserWindow: class {}, session: {}, shell: {} }));
vi.mock("../src/main/network", () => ({ configureChromiumNetwork: vi.fn(async () => undefined), chromiumFetch: vi.fn(), configureChromiumSession: vi.fn() }));
vi.mock("../src/main/secrets", () => ({ SecretStore: class {
  getConnectorSecret = vi.fn(async () => null);
  setConnectorSecret = vi.fn(async () => "fixture-account");
} }));
import { createApplicationServices } from "../src/main/app-services";
import { LocalCodexCli } from "../src/main/codex-cli";

afterEach(() => vi.restoreAllMocks());
describe("application assistant shutdown", () => {
  it("starts child cleanup before the IPC drain and keeps SQLite alive until it finishes", async () => {
    let finish!: () => void;
    const close = vi.spyOn(LocalCodexCli.prototype, "close").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const services = await createApplicationServices(":memory:");
    try {
      services.beginShutdown(); services.beginShutdown();
      expect(close).toHaveBeenCalledTimes(1);
      let closed = false;
      const first = services.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(services.database.listSources()).toEqual([]);
      finish(); await first;
      await services.close();
      expect(close).toHaveBeenCalledTimes(1);
      expect(() => services.database.listSources()).toThrow();
    } finally { finish?.(); await services.close(); }
  });

  it("retains an early assistant cleanup error for the shutdown handler", async () => {
    vi.spyOn(LocalCodexCli.prototype, "close").mockRejectedValue(new Error("synthetic cleanup failure"));
    const services = await createApplicationServices(":memory:");
    try {
      services.beginShutdown(); await Promise.resolve();
      await expect(services.close()).rejects.toThrow("synthetic cleanup failure");
      expect(services.database.listSources()).toEqual([]);
    } finally { services.database.close(); }
  });
});
