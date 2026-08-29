import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import {
  parseAiStreamRequest,
  parseAiProviderConfiguration,
  parseAiProviderId,
  parseEntryListQuery,
  parseExtractionRule,
  parseProfileSubscriptionInput,
  parseSourceSettings,
  requireEntityId,
  requireText
} from "../src/main/ipc-validation";
import { MAX_AI_ARTICLE_TEXT_LENGTH } from "../src/shared/ai-input";

describe("IPC input validation", () => {
  it("keeps every renderer channel unique", () => {
    const channels = Object.values(IPC_CHANNELS).flatMap((group) => Object.values(group));
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("accepts only bounded source and extraction settings", () => {
    expect(parseSourceSettings({
      title: "Example", category: "技术", kind: "generic", pollingEnabled: true, refreshIntervalMinutes: 60
    })).toEqual({
      title: "Example", category: "技术", kind: "generic", pollingEnabled: true, refreshIntervalMinutes: 60
    });
    expect(parseExtractionRule({ version: 1, itemRootSelector: "article", rendererRequired: false })).toEqual({
      version: 1, itemRootSelector: "article", rendererRequired: false
    });
    expect(() => parseSourceSettings({ title: "Example", kind: "x", pollingEnabled: true, refreshIntervalMinutes: 31 })).toThrow("刷新时间无效");
    expect(() => parseExtractionRule({ version: 2 })).toThrow("提取规则无效");
  });

  it("rejects malformed renderer IDs, filters, and profile payloads", () => {
    expect(requireEntityId("source-1")).toBe("source-1");
    expect(() => requireEntityId(" ")).toThrow("项目无效");
    expect(() => requireText("x".repeat(21), "太长", 20)).toThrow("太长");
    expect(parseEntryListQuery({ sourceId: "source-1", startAt: 1, endAt: 2, limit: 100 })).toEqual({ sourceId: "source-1", startAt: 1, endAt: 2, limit: 100 });
    expect(() => parseEntryListQuery({ startAt: 2, endAt: 2 })).toThrow("时间筛选范围无效");
    expect(() => parseProfileSubscriptionInput({ title: "missing URL" })).toThrow("主页地址无效");
  });

  it("supports all approved Codex effort values but bounds streamed AI requests", () => {
    expect(parseAiProviderConfiguration({ provider: "codex-cli", model: "gpt-5.6-terra", effort: "max" })).toMatchObject({ effort: "max" });
    expect(parseAiProviderId("openai")).toBe("openai");
    expect(() => parseAiProviderId("unknown")).toThrow("AI 服务无效");
    const request = {
      requestId: "request_123",
      request: {
        provider: "codex-cli",
        question: "请解释这段内容",
        article: { title: "文章", url: "https://example.com/post", text: "正文" },
        selection: { text: "一段话", intent: "explain" }
      }
    };
    expect(parseAiStreamRequest(request)).toEqual(request);
    expect(() => parseAiStreamRequest({ ...request, request: { ...request.request, question: "x".repeat(3_001) } })).toThrow("问题过长");
    const longArticle = { ...request, request: { ...request.request, article: { ...request.request.article, text: "x".repeat(MAX_AI_ARTICLE_TEXT_LENGTH + 1) } } };
    expect(() => parseAiStreamRequest(longArticle)).toThrow("文章上下文超过 18,000 个字符");
  });

  it("accepts context-free selected-text translation only", () => {
    const translation = {
      requestId: "translation_123",
      request: {
        provider: "codex-cli",
        question: "请翻译所选文字。",
        selection: { text: "Selected text", intent: "translate" }
      }
    };

    expect(parseAiStreamRequest(translation)).toEqual(translation);
    const withArticleContext = {
      ...translation,
      request: { ...translation.request, article: { title: "文章标题", text: "不应上传的正文" } }
    };
    expect(() => parseAiStreamRequest(withArticleContext)).toThrow("翻译请求不应包含文章上下文");
  });
});
