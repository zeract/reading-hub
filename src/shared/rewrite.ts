import type { AiProviderId, AiReasoningEffort } from "./types";
import { validAiEffort, validAiModelId } from "./ai-model";
export interface RewriteSettings {
    provider: AiProviderId;
    model: string;
    effort: AiReasoningEffort;
}
export interface RewriteResult {
    markdown: string;
    provider: AiProviderId;
    model: string;
    createdAt: number;
    sourceUrl: string;
    sourceTitle: string;
    sourceHash: string;
    promptVersion: number;
}
export interface ArticleRewrite {
    entryId: string;
    jobId: string;
    status: "queued" | "running" | "complete" | "failed" | "cancelled";
    settings: RewriteSettings;
    completedChunks: number;
    totalChunks: number;
    updatedAt: number;
    error?: string;
    result?: RewriteResult;
}
export function parseRewriteSettings(value: unknown): RewriteSettings {
    const v = value as Partial<RewriteSettings> | null;
    if (!v || typeof v !== "object" || !["codex-cli", "deepseek", "openai"].includes(v.provider || "") || !validAiModelId(v.model) || !validAiEffort(v.effort)) {
        throw new Error("改写模型设置无效，请重新选择服务和模型。");
    }
    return { provider: v.provider!, model: v.model!, effort: v.effort! };
}
export function rewritePending(value?: ArticleRewrite): boolean { return value?.status === "queued" || value?.status === "running"; }
