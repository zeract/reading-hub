import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/main/ai-service";
import { CodexCliError, type CodexCliRunner } from "../src/main/codex-cli";
import type { AiProviderId } from "../src/shared/types";

class MemorySecrets {
  readonly values = new Map<string, string>();

  async getConnectorSecret(account?: string): Promise<string | null> {
    return account ? this.values.get(account) || null : null;
  }

  async setConnectorSecret(connectorId: string, accountId: string, value: string): Promise<string> {
    const account = `${connectorId}:${accountId}`;
    this.values.set(account, value);
    return account;
  }

  async clearConnectorSecret(account?: string): Promise<void> {
    if (account) this.values.delete(account);
  }
}

const article = {
  title: "一篇带公式的文章",
  url: "https://example.com/article",
  sourceTitle: "示例来源",
  text: "<script>不应作为 HTML 发送</script>这里是用于解释公式的正文摘录。"
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function configure(service: AiService, provider: AiProviderId, model?: string): Promise<void> {
  await service.configure({ provider, apiKey: "test-key", model });
}

describe("AI learning service", () => {
  it("uses the Responses API with store disabled for OpenAI reading questions", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ output_text: "这是对公式的解释。" }));
    const service = new AiService(new MemorySecrets(), fetcher);
    await configure(service, "openai");

    const answer = await service.ask({ provider: "openai", question: "这个公式是什么意思？", article });

    expect(answer).toEqual({ provider: "openai", model: "gpt-5.6", text: "这是对公式的解释。" });
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({ method: "POST" }));
    const request = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(request).toMatchObject({ model: "gpt-5.6", store: false, reasoning: { effort: "low" } });
    expect(JSON.stringify(request)).toContain("<article-excerpt>");
    expect(JSON.stringify(request)).not.toContain("<script>");
  });

  it("uses DeepSeek's chat-completions shape and reads its answer", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: "可以从这个定义开始理解。" } }] }));
    const service = new AiService(new MemorySecrets(), fetcher);
    await configure(service, "deepseek", "deepseek-v4-pro");

    const answer = await service.ask({ provider: "deepseek", question: "请用直觉解释。", article });

    expect(answer).toEqual({ provider: "deepseek", model: "deepseek-v4-pro", text: "可以从这个定义开始理解。" });
    expect(fetcher).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions", expect.objectContaining({ method: "POST" }));
    const request = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(request).toMatchObject({ model: "deepseek-v4-pro", stream: false, max_tokens: 1_400 });
  });

  it("delegates to the local Codex CLI without reading or storing an API key", async () => {
    const codexCli: CodexCliRunner = {
      status: vi.fn().mockResolvedValue({ available: true, command: "/usr/local/bin/codex" }),
      ask: vi.fn().mockResolvedValue("可以把这个公式理解为一个归一化步骤。")
    };
    const fetcher = vi.fn();
    const secrets = new MemorySecrets();
    const service = new AiService(secrets, fetcher, codexCli);

    const providers = await service.listProviders();
    const codex = providers.find((provider) => provider.id === "codex-cli");
    expect(codex).toMatchObject({ configured: true, requiresApiKey: false, model: "default", effort: "medium" });

    const answer = await service.ask({ provider: "codex-cli", question: "请解释公式。", article });

    expect(answer).toEqual({ provider: "codex-cli", model: "Codex 默认模型 · medium", text: "可以把这个公式理解为一个归一化步骤。" });
    expect(codexCli.ask).toHaveBeenCalledWith(expect.stringContaining("不要运行命令"), expect.stringContaining("<article-excerpt>"), { model: undefined, effort: "medium" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(secrets.values).toHaveLength(0);
  });

  it("stores only Codex model preferences and passes them to the local CLI", async () => {
    const codexCli: CodexCliRunner = {
      status: vi.fn().mockResolvedValue({ available: true, command: "/usr/local/bin/codex" }),
      ask: vi.fn().mockResolvedValue("已按选择的模型回答。")
    };
    const secrets = new MemorySecrets();
    const service = new AiService(secrets, vi.fn(), codexCli);

    await service.configure({ provider: "codex-cli", model: "gpt-5.3-codex", effort: "xhigh" });
    const answer = await service.ask({ provider: "codex-cli", question: "请解释公式。", article });

    expect(answer.model).toBe("gpt-5.3-codex · xhigh");
    expect(codexCli.ask).toHaveBeenCalledWith(expect.any(String), expect.any(String), { model: "gpt-5.3-codex", effort: "xhigh" });
    expect([...secrets.values.values()][0]).toContain("gpt-5.3-codex");
    expect([...secrets.values.values()][0]).not.toContain("apiKey");
  });

  it("reports a local Codex login failure without leaking CLI details", async () => {
    const codexCli: CodexCliRunner = {
      status: vi.fn().mockResolvedValue({ available: true, command: "/usr/local/bin/codex" }),
      ask: vi.fn().mockRejectedValue(new CodexCliError("Codex CLI 尚未完成登录。请在终端运行 codex。"))
    };
    const service = new AiService(new MemorySecrets(), vi.fn(), codexCli);

    await expect(service.ask({ provider: "codex-cli", question: "请解释。", article })).rejects.toThrow("Codex CLI 尚未完成登录");
  });

  it("does not expose provider credentials in request errors and allows credentials to be cleared", async () => {
    const secrets = new MemorySecrets();
    const service = new AiService(secrets, vi.fn().mockResolvedValue(response({}, 401)));
    await configure(service, "openai");

    const failure = await service.ask({ provider: "openai", question: "为什么？", article }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("OpenAI 拒绝了 API Key");
    expect((failure as Error).message).not.toContain("test-key");
    await service.clear("openai");
    await expect(service.ask({ provider: "openai", question: "为什么？", article })).rejects.toThrow("请先配置");
    expect(secrets.values).toHaveLength(0);
  });
});
