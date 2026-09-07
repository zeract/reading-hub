import { queryObjects } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";
import type { CodexCliRunner } from "../src/main/codex-cli";

const request = { provider: "codex-cli" as const, question: "Fixture?", article: {
  title: "Fixture", url: "https://example.com/article", text: "Synthetic excerpt"
} };

describe("completed AI subscriber ownership", () => {
  it("releases each completed subscriber while retaining another active request", async () => {
    const delivered: string[] = [];
    class Subscriber {
      constructor(readonly id: string) {}
      publish(text: string) { delivered.push(`${this.id}:${text}`); }
    }
    const retained: Array<(text: string) => void> = [];
    const complete: Array<(text: string) => void> = [];
    const runner: CodexCliRunner = { status: async () => ({ available: true }), ask: vi.fn(),
      askStream: (_instruction, _prompt, _options, onDelta) => {
        retained.push(onDelta);
        return new Promise<string>((resolve) => complete.push(resolve));
      }
    };
    const service = new AiService({ getConnectorSecret: async () => null, setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn() }, vi.fn(), runner);
    function start(id: string) {
      const subscriber = new Subscriber(id);
      return service.askStream(request, subscriber.publish.bind(subscriber));
    }
    const first = start("first"), second = start("second");
    await vi.waitFor(() => expect(complete).toHaveLength(2));
    expect(queryObjects(Subscriber, { format: "count" })).toBe(2);
    complete[0]("First"); await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queryObjects(Subscriber, { format: "count" })).toBe(1);
    retained[0]("Late"); retained[1]("Still active");
    expect(delivered).toEqual(["second:Still active"]);
    complete[1]("Second"); await second;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queryObjects(Subscriber, { format: "count" })).toBe(0);
    retained[1]("Late");
    expect(delivered).toHaveLength(1);
  });

  it.each(["success", "failure", "cancel"] as const)("releases the caller after %s even if a runner retains the forwarding callback", async (outcome) => {
    let delivered = 0;
    class Subscriber {
      received = 0;
      publish(_text: string) { this.received++; delivered++; }
    }
    let retained!: (text: string) => void;
    const controller = new AbortController();
    const runner: CodexCliRunner = {
      status: async () => ({ available: true }), ask: vi.fn(),
      askStream: async (_instruction, _prompt, _options, onDelta) => {
        retained = onDelta;
        onDelta("Current");
        if (outcome === "cancel") controller.abort(new Error("Fixture cancelled"));
        if (outcome === "failure") throw new Error("Synthetic failure");
        return "Current";
      }
    };
    const service = new AiService({ getConnectorSecret: async () => null, setConnectorSecret: vi.fn(), clearConnectorSecret: vi.fn() }, vi.fn(), runner);
    function start() {
      const subscriber = new Subscriber();
      return service.askStream(request, subscriber.publish.bind(subscriber), controller.signal);
    }
    if (outcome === "success") expect((await start()).text).toBe("Current");
    else await expect(start()).rejects.toThrow(outcome === "cancel" ? "Fixture cancelled" : "未能完成回答");
    // Let the completed async stack unwind; count only this fixture's type.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queryObjects(Subscriber, { format: "count" })).toBe(0);
    retained("Late");
    expect(delivered).toBe(1);
  });
});
