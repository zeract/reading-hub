import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";
import { MAX_AI_ANSWER_LENGTH } from "../src/shared/types";

type Provider = "openai" | "deepseek";
const article = { title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt" };
const diagnostic = "synthetic-private-diagnostic";
const failed = "服务在生成回答时返回错误，请稍后重试。";
const incomplete = "AI 回答未完整生成，请缩短问题或稍后重试。";
const draft = (provider: Provider, text = "Draft") => provider === "openai"
  ? { type: "response.output_text.delta", delta: text }
  : { choices: [{ delta: { content: text }, finish_reason: null }] };
const output = (provider: Provider, fields: Record<string, unknown> = {}) => provider === "openai"
  ? { output_text: "Complete", ...fields }
  : { choices: [{ message: { content: "Complete" }, ...fields }] };
const sse = (...events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

function fixture(responses: Response[]) {
  return new AiService({
    getConnectorSecret: async () => JSON.stringify({ apiKey: "synthetic-key", model: "fixture" }),
    setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn()
  }, async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
}

const cases: Array<{ provider: Provider; label: string; event: Record<string, unknown>; json: unknown; message: string }> = [
  ...(["failed", "incomplete"] as const).map((status) => ({
    provider: "openai" as const, label: status,
    event: { type: `response.${status}`, response: { status, error: status === "failed" ? { message: diagnostic } : null } },
    json: output("openai", { status, error: status === "failed" ? { message: diagnostic } : null }),
    message: status === "failed" ? failed : incomplete
  })),
  ...(["length", "content_filter", "insufficient_system_resource", "tool_calls"] as const).map((reason) => ({
    provider: "deepseek" as const, label: reason,
    event: { choices: [{ delta: { content: diagnostic }, finish_reason: reason }] },
    json: output("deepseek", { finish_reason: reason }),
    message: reason === "insufficient_system_resource" ? failed : incomplete
  })),
  ...(["openai", "deepseek"] as const).map((provider) => ({
    provider, label: "error envelope", event: { error: { message: diagnostic } },
    json: { ...output(provider), error: { message: diagnostic } }, message: failed
  }))
];

describe("AI provider outcomes", () => {
  it.each(["failed", "incomplete"] as const)("OpenAI response.%s is authoritative without nested diagnostics", async (status) => {
    const response = new Response(sse(draft("openai"), { type: `response.${status}` }), { headers: { "content-type": "text/event-stream" } });
    await expect(fixture([response]).askStream({ provider: "openai", question: "Fixture?", article }, vi.fn()))
      .rejects.toMatchObject({ message: status === "failed" ? failed : incomplete });
  });

  it("does not publish a cancelled OpenAI JSON snapshot", async () => {
    const delta = vi.fn();
    await expect(fixture([Response.json(output("openai", { status: "cancelled", error: null }))])
      .askStream({ provider: "openai", question: "Fixture?", article }, delta)).rejects.toMatchObject({ message: incomplete });
    expect(delta).not.toHaveBeenCalled();
  });

  it.each(cases)("$provider $label rejects an open SSE body, stops later deltas and allows retry", async ({ provider, event, message }) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(draft(provider), event, draft(provider, "Late"))));
        // Deliberately do not close: semantic failure must not wait for EOF.
      }, cancel
    });
    const service = fixture([new Response(body, { headers: { "content-type": "text/event-stream" } }), Response.json(output(provider))]);
    const delta = vi.fn();
    await expect(service.askStream({ provider, question: "Fixture?", article }, delta)).rejects.toMatchObject({ name: "AiServiceError", message });
    expect(delta).toHaveBeenCalledExactlyOnceWith("Draft");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    await expect(service.askStream({ provider, question: "Retry?", article }, vi.fn())).resolves.toMatchObject({ text: "Complete" });
  }, 1000);

  it.each(cases)("$provider $label rejects JSON before publishing its partial output", async ({ provider, json, message }) => {
    const delta = vi.fn();
    await expect(fixture([Response.json(json)]).askStream({ provider, question: "Fixture?", article }, delta)).rejects.toMatchObject({ name: "AiServiceError", message });
    expect(delta).not.toHaveBeenCalled();
  });

  it.each(["openai", "deepseek"] as const)("%s still checks failures after the display budget is exhausted", async (provider) => {
    const failure = cases.find((item) => item.provider === provider)!;
    const response = new Response(sse(draft(provider, "x".repeat(MAX_AI_ANSWER_LENGTH)), failure.event), { headers: { "content-type": "text/event-stream" } });
    const delta = vi.fn();
    await expect(fixture([response]).askStream({ provider, question: "Fixture?", article }, delta)).rejects.toThrow(failure.message);
    expect(delta).toHaveBeenCalledExactlyOnceWith("x".repeat(MAX_AI_ANSWER_LENGTH));
  });

  it.each(["openai", "deepseek"] as const)("%s accepts normal completion and ignores progress metadata", async (provider) => {
    const events = provider === "openai"
      ? [{ type: "response.created", response: { status: "in_progress", error: null } }, draft(provider), { type: "response.completed", response: { status: "completed", error: null } }]
      : [{ choices: [], usage: { total_tokens: 1 } }, draft(provider), { choices: [{ delta: { content: "!" }, finish_reason: "stop" }] }];
    const response = new Response(sse(...events) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    const json = output(provider, provider === "openai" ? { status: "completed", error: null } : { finish_reason: "stop" });
    const service = fixture([response, Response.json(json)]);
    await expect(service.askStream({ provider, question: "Fixture?", article }, vi.fn())).resolves.toMatchObject({ text: provider === "openai" ? "Draft" : "Draft!" });
    await expect(service.askStream({ provider, question: "Fixture?", article }, vi.fn())).resolves.toMatchObject({ text: "Complete" });
  });
});
