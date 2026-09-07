import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";

const article = { title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt" };
type Provider = "openai" | "deepseek";
const event = (provider: Provider, text: string) => provider === "openai"
  ? { type: "response.output_text.delta", delta: text }
  : { choices: [{ delta: { content: text } }] };

function fixture(text: string, fragmented = true) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = fragmented ? offset + 1 : bytes.length;
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    }
  }, { highWaterMark: 0 });
  const service = new AiService({
    getConnectorSecret: async () => JSON.stringify({ apiKey: "synthetic-key", model: "fixture" }),
    setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn()
  }, async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  return { service, body };
}

describe.each(["openai", "deepseek"] as const)("%s SSE framing", (provider) => {
  it("stops publishing later events in the same chunk when the listener cancels", async () => {
    const payload = ["First", "Must not arrive"].map((text) => `data: ${JSON.stringify(event(provider, text))}\n\n`).join("");
    const { service, body } = fixture(payload, false);
    const controller = new AbortController();
    const delta = vi.fn(() => controller.abort(new Error("Fixture cancelled")));
    await expect(service.askStream({ provider, question: "Fixture?", article }, delta, controller.signal)).rejects.toThrow("Fixture cancelled");
    expect(delta).toHaveBeenCalledExactlyOnceWith("First");
    expect(body.locked).toBe(false);
  });

  it.each(["\n", "\r\n", "\r"])("reads byte-fragmented Unicode with line ending %j", async (newline) => {
    const payload = ["中文 🧪", " café"].map((text) => `data: ${JSON.stringify(event(provider, text))}${newline}${newline}`).join("");
    const { service, body } = fixture(`\uFEFF: heartbeat${newline}${newline}${payload}data: [DONE]${newline}${newline}`);
    const delta = vi.fn();
    const answer = await service.askStream({ provider, question: "Fixture?", article }, delta);
    expect(delta.mock.calls.flat()).toEqual(["中文 🧪", " café"]);
    expect(answer.text).toBe("中文 🧪 café");
    expect(body.locked).toBe(false);
  });

  it.each(["", "\n"])("does not dispatch a final event missing its blank line (suffix=%j)", async (suffix) => {
    const { service, body } = fixture(`data: ${JSON.stringify(event(provider, "Complete"))}\n\ndata: ${JSON.stringify(event(provider, "Unfinished"))}${suffix}`);
    const delta = vi.fn();
    const answer = await service.askStream({ provider, question: "Fixture?", article }, delta);
    expect(answer.text).toBe("Complete");
    expect(delta).toHaveBeenCalledExactlyOnceWith("Complete");
    expect(body.locked).toBe(false);
  });

  it("supports multiline data and mixed CR/LF separators without forwarding metadata", async () => {
    const data = JSON.stringify(event(provider, "Multiline"), null, 2).split("\n").map((line) => `data: ${line}`).join("\r");
    const { service, body } = fixture(`event: message\r\nid: fixture\n: comment\r${data}\r\ndata\n\n`);
    const delta = vi.fn();
    const answer = await service.askStream({ provider, question: "Fixture?", article }, delta);
    expect(answer.text).toBe("Multiline");
    expect(delta).toHaveBeenCalledExactlyOnceWith("Multiline");
    expect(body.locked).toBe(false);
  });
});
