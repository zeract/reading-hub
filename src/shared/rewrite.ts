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
    quality?: RewriteQuality;
    sections?: string[];
    review?: RewriteReview;
    structureRepair?: { version:1; provider:AiProviderId; model:string; repairedAt:number; sourceHash:string };
}
export interface ArticleRewrite {
    entryId: string;
    jobId: string;
    kind?: "generate" | "review";
    status: "queued" | "running" | "complete" | "failed" | "cancelled";
    settings: RewriteSettings;
    completedChunks: number;
    totalChunks: number;
    updatedAt: number;
    stage?: RewriteStage;
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

export type RewriteRequestStage = "write" | "review";
// Legacy stage labels remain readable for interrupted tasks from older releases.
export type RewriteStage = RewriteRequestStage | "plan" | "outline" | "revise";
export interface RewriteQuality { version: 1; reviewedSections: number; reviewedBlocks: number; repairedSections: number; requests: number; terms: Array<{source:string;target:string}> }
export const REWRITE_STAGE_LABELS: Record<RewriteStage,string> = {plan:"梳理原文",outline:"统一提纲与术语",write:"生成改写",review:"对照原文检查",revise:"修订问题段落"};

export interface RewriteIssue { sectionId: string; blockId: string; kind: string; message: string; sourceQuote: string }
export interface RewriteReview { provider?: AiProviderId; model?: string; checkedAt: number; reviewedSections: number; requests: number; issues: RewriteIssue[] }
