import { afterEach, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn(), setProxy: vi.fn(async () => undefined) }));
vi.mock("electron", () => ({ net: { fetch: network.fetch }, session: { defaultSession: { setProxy: network.setProxy } } }));
vi.mock("../src/main/chromium-manual-fetch", () => ({ chromiumManualFetch: network.fetch }));
import { AiService } from "../src/main/ai-service";
import { configureChromiumNetwork } from "../src/main/network";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); network.fetch.mockReset(); network.setProxy.mockClear(); });

it.each(["openai", "deepseek"] as const)("uses the configured Chromium transport without browser credentials for %s", async (provider) => {
  const nodeFetch = vi.fn(async () => { throw new Error("Unexpected Node transport"); });
  vi.stubGlobal("fetch", nodeFetch);
  const values = new Map<string, string>();
  const service = new AiService({
    async getConnectorSecret(key) { return values.get(key!) ?? null; },
    async setConnectorSecret(connector, id, value) { const key = `${connector}:${id}`; values.set(key, value); return key; },
    async clearConnectorSecret(key) { values.delete(key!); }
  });
  await configureChromiumNetwork({ HTTPS_PROXY: "http://127.0.0.1:7890" });
  await service.configure({ provider, apiKey: "fixture-key" });
  network.fetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/fixture-stream" } }));
  const event = provider === "openai"
    ? { type: "response.output_text.delta", delta: "Fixture answer" }
    : { choices: [{ delta: { content: "Fixture answer" } }] };
  network.fetch.mockResolvedValueOnce(new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  const deltas: string[] = [];
  try {
    const answer = await service.askStream({ provider, question: "Fixture question", article: { title: "Fixture", url: "https://example.com/article", sourceTitle: "Fixture", text: "Fixture excerpt" } }, (delta) => deltas.push(delta));
    expect(answer.text).toBe("Fixture answer");
    expect(deltas.join("")).toBe("Fixture answer");
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(network.setProxy).toHaveBeenCalledWith(expect.objectContaining({ mode: "fixed_servers", proxyRules: "https=http://127.0.0.1:7890" }));
    expect(network.fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of network.fetch.mock.calls) {
      expect(new URL(url).hostname).toBe(provider === "openai" ? "api.openai.com" : "api.deepseek.com");
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "manual" });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-key");
      expect(new Headers(init.headers).has("cookie")).toBe(false);
    }
  } finally { await service.close(); }
});
