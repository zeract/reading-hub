import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";
import type { AiProviderId } from "../src/shared/types";

const question = (provider: AiProviderId = "openai") => ({
  provider, question: "Explain the fixture.",
  article: { title: "Fixture article", url: "https://example.com/post", text: "A synthetic paragraph." }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const values = new Map<string, string>([["ai:openai", JSON.stringify({ apiKey: "fixture-old-key", model: "fixture-old-model" })]]);
  const started = deferred<void>();
  const release = deferred<void>();
  let holdFirstWrite = true;
  const secrets = {
    getConnectorSecret: vi.fn(async (account?: string) => account ? values.get(account) ?? null : null),
    setConnectorSecret: vi.fn(async (connector: string, provider: string, value: string) => {
      if (provider === "openai" && holdFirstWrite) {
        holdFirstWrite = false;
        started.resolve();
        await release.promise;
      }
      const account = `${connector}:${provider}`;
      values.set(account, value);
      return account;
    }),
    clearConnectorSecret: vi.fn(async (account?: string) => { if (account) values.delete(account); })
  };
  const cli = { status: vi.fn(async () => ({ available: true })), ask: vi.fn(async () => "Fixture answer") };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "Fixture answer" }), { headers: { "content-type": "application/json" } }));
  const service = new AiService(secrets, fetcher, cli);
  return { service, secrets, values, started, release, fetcher, cli };
}

describe("AI configuration ordering", () => {
  it("does not resurrect credentials when a pending save is followed by clear", async () => {
    const run = fixture();
    const saving = run.service.configure({ provider: "openai", apiKey: "fixture-new-key", model: "fixture-new-model" });
    await run.started.promise;
    const clearing = run.service.clear("openai");
    run.release.resolve();
    await Promise.all([saving, clearing]);
    expect(run.values.has("ai:openai")).toBe(false);
  });

  it("applies a later partial update to the newly saved key instead of stale credentials", async () => {
    const run = fixture();
    const first = run.service.configure({ provider: "openai", apiKey: "fixture-new-key", model: "fixture-first-model" });
    await run.started.promise;
    const second = run.service.configure({ provider: "openai", model: "fixture-final-model" });
    await Promise.resolve();
    run.release.resolve();
    await Promise.all([first, second]);
    expect(JSON.parse(run.values.get("ai:openai")!)).toEqual({ apiKey: "fixture-new-key", model: "fixture-final-model" });
  });

  it("lists provider settings after an earlier save has finished", async () => {
    const run = fixture();
    const saving = run.service.configure({ provider: "openai", apiKey: "fixture-new-key", model: "fixture-new-model" });
    await run.started.promise;
    const listing = run.service.listProviders();
    run.release.resolve();
    await saving;
    expect((await listing).find((provider) => provider.id === "openai")?.model).toBe("fixture-new-model");
  });

  it("uses the newly saved configuration for a question admitted after that save", async () => {
    const run = fixture();
    const saving = run.service.configure({ provider: "openai", apiKey: "fixture-new-key", model: "fixture-new-model" });
    await run.started.promise;
    const answering = run.service.askStream(question(), () => undefined);
    run.release.resolve();
    await saving;
    expect((await answering).model).toBe("fixture-new-model");
    expect(run.fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer fixture-new-key" }) }));
  });

  it("cancels a queued question without allowing the following clear to overtake the save", async () => {
    const run = fixture();
    const saving = run.service.configure({ provider: "openai", apiKey: "fixture-new-key" });
    await run.started.promise;
    const controller = new AbortController();
    const outcome = run.service.askStream(question(), () => undefined, controller.signal).catch((error) => error);
    const clearing = run.service.clear("openai");
    controller.abort(new Error("cancel queued question"));
    expect((await outcome).message).toBe("cancel queued question");
    expect(run.secrets.clearConnectorSecret).not.toHaveBeenCalled();
    run.release.resolve();
    await Promise.all([saving, clearing]);
    expect(run.fetcher).not.toHaveBeenCalled();
    expect(run.values.has("ai:openai")).toBe(false);
  });

  it("allows another provider's configuration to finish while a write is pending", async () => {
    const run = fixture();
    const saving = run.service.configure({ provider: "openai", apiKey: "fixture-new-key" });
    await run.started.promise;
    await run.service.configure({ provider: "deepseek", apiKey: "fixture-independent-key", model: "fixture-independent-model" });
    expect(run.values.has("ai:deepseek")).toBe(true);
    expect(JSON.parse(run.values.get("ai:openai")!).apiKey).toBe("fixture-old-key");
    run.release.resolve();
    await saving;
  });

  it("does not hold configuration writes behind a slow provider answer", async () => {
    const run = fixture();
    const entered = deferred<void>();
    const response = deferred<Response>();
    run.fetcher.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const answering = run.service.askStream(question(), () => undefined);
    await entered.promise;
    await run.service.clear("openai");
    expect(run.values.has("ai:openai")).toBe(false);
    response.resolve(new Response(JSON.stringify({ output_text: "In-flight fixture answer" }), { headers: { "content-type": "application/json" } }));
    expect((await answering).text).toBe("In-flight fixture answer");
  });

  it("keeps later operations runnable after a Keychain write fails", async () => {
    const run = fixture();
    run.secrets.setConnectorSecret.mockRejectedValueOnce(new Error("Fixture Keychain failure"));
    const saving = run.service.configure({ provider: "openai", apiKey: "fixture-new-key" });
    const failed = expect(saving).rejects.toThrow("Fixture Keychain failure");
    const clearing = run.service.clear("openai");
    await failed;
    await clearing;
    expect(run.values.has("ai:openai")).toBe(false);
    const restarted = new AiService(run.secrets, run.fetcher, run.cli);
    expect((await restarted.listProviders()).find((provider) => provider.id === "openai")?.configured).toBe(false);
  });

  it("does not restore local CLI preferences when a slow configuration is followed by clear", async () => {
    const run = fixture();
    const status = deferred<{ available: boolean }>();
    const entered = deferred<void>();
    run.cli.status.mockImplementationOnce(async () => { entered.resolve(); return status.promise; });
    const saving = run.service.configure({ provider: "codex-cli", model: "default", effort: "high" });
    await entered.promise;
    const clearing = run.service.clear("codex-cli");
    status.resolve({ available: true });
    await Promise.all([saving, clearing]);
    expect(run.values.has("ai:codex-cli")).toBe(false);
  });

  it.each(["openai", "codex-cli"] as const)("does not start %s work if cancelled during a configuration read", async (provider) => {
    const run = fixture();
    const entered = deferred<void>();
    const read = deferred<string | null>();
    run.secrets.getConnectorSecret.mockImplementationOnce(async () => { entered.resolve(); return read.promise; });
    const controller = new AbortController();
    const outcome = run.service.askStream(question(provider), () => undefined, controller.signal).catch((error) => error);
    await entered.promise;
    controller.abort(new Error("cancel configuration read"));
    read.resolve(provider === "openai" ? run.values.get("ai:openai")! : null);
    expect((await outcome).message).toBe("cancel configuration read");
    expect(run.fetcher).not.toHaveBeenCalled();
    expect(run.cli.ask).not.toHaveBeenCalled();
  });
});
