import { net, session } from "electron";
import type { ProxyConfig } from "electron";

type Environment = Record<string, string | undefined>;

/**
 * Electron honours macOS proxy settings, but a development process launched
 * from a terminal also commonly relies on the standard HTTP(S)_PROXY variables.
 * Chromium does not inherit those variables automatically, so translate their
 * safe routing components to an Electron session configuration at startup.
 */
export function proxyConfigFromEnvironment(environment: Environment = process.env): ProxyConfig | undefined {
  const all = proxyFromEnvironment(environment, "ALL_PROXY", "all_proxy");
  const explicitHttp = proxyFromEnvironment(environment, "HTTP_PROXY", "http_proxy");
  const explicitHttps = proxyFromEnvironment(environment, "HTTPS_PROXY", "https_proxy");
  const http = explicitHttp || all;
  const https = explicitHttps || all;
  if (!http && !https) return undefined;

  const rules = all && !explicitHttp && !explicitHttps
    ? all.rule
    : [http ? `http=${http.rule}` : undefined, https ? `https=${https.rule}` : undefined].filter(Boolean).join(";");
  const bypass = ["<local>", ...proxyBypassRules(environmentValue(environment, "NO_PROXY", "no_proxy"))];
  return {
    mode: "fixed_servers",
    proxyRules: rules,
    // Always keep the development server and OAuth loopback callbacks local;
    // the user-provided NO_PROXY rules retain their original bypass semantics.
    proxyBypassRules: [...new Set(bypass)].join(",")
  };
}

/** Configure the default Chromium session once, after Electron is ready. */
export async function configureChromiumNetwork(environment: Environment = process.env): Promise<void> {
  const config = proxyConfigFromEnvironment(environment);
  if (!config) return;
  await session.defaultSession.setProxy(config);
}

function environmentValue(environment: Environment, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function proxyFromEnvironment(environment: Environment, ...names: string[]): { rule: string } | undefined {
  for (const name of names) {
    const proxy = proxyEndpoint(environment[name]?.trim());
    if (proxy) return proxy;
  }
  return undefined;
}

function proxyEndpoint(value: string | undefined): { rule: string } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!url.hostname || !["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) return undefined;
    // ProxyConfig does not accept userinfo in proxyRules. Do not leak any
    // password from an environment variable into Chromium configuration or logs.
    return { rule: `${url.protocol}//${url.host}` };
  } catch {
    return undefined;
  }
}

function proxyBypassRules(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).map((rule) => rule.trim()).filter(Boolean);
}

/**
 * Electron's Chromium network stack honours macOS proxy configuration. The
 * startup adapter above also imports standard terminal proxy variables. Node's
 * built-in fetch does neither reliably on macOS.
 */
export function chromiumFetch(input: string, init?: RequestInit) {
  return net.fetch(input, init);
}
