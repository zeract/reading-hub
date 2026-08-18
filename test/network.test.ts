import { describe, expect, it, vi } from "vitest";
import { configureChromiumSession, proxyConfigFromEnvironment } from "../src/main/network";

describe("Chromium proxy configuration", () => {
  it("maps standard terminal proxy variables to Electron without copying credentials", () => {
    const config = proxyConfigFromEnvironment({
      HTTP_PROXY: "http://proxy-user:proxy-password@127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1,.internal.example"
    });

    expect(config).toEqual({
      mode: "fixed_servers",
      proxyRules: "http=http://127.0.0.1:7890;https=http://127.0.0.1:7890",
      proxyBypassRules: "<local>,localhost,127.0.0.1,.internal.example"
    });
    expect(JSON.stringify(config)).not.toContain("proxy-password");
  });

  it("uses ALL_PROXY for both protocols and leaves system routing untouched when unset", () => {
    expect(proxyConfigFromEnvironment({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toEqual({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:1080",
      proxyBypassRules: "<local>"
    });
    expect(proxyConfigFromEnvironment({})).toBeUndefined();
  });

  it("ignores malformed or unsupported proxy values rather than breaking all networking", () => {
    expect(proxyConfigFromEnvironment({ HTTPS_PROXY: "not a proxy" })).toBeUndefined();
    expect(proxyConfigFromEnvironment({ HTTPS_PROXY: "ftp://proxy.example" })).toBeUndefined();
    expect(proxyConfigFromEnvironment({ HTTPS_PROXY: "not a proxy", https_proxy: "http://127.0.0.1:7890" })?.proxyRules)
      .toBe("https=http://127.0.0.1:7890");
  });

  it("applies the same safe proxy route to an isolated Chromium session", async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined);

    await configureChromiumSession({ setProxy }, { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost" });

    expect(setProxy).toHaveBeenCalledOnce();
    expect(setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: "https=http://127.0.0.1:7890",
      proxyBypassRules: "<local>,localhost"
    });
  });
});
