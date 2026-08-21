import type { AiReasoningEffort } from "../shared/types";

export const CODEX_EFFORT_OPTIONS: Array<{ value: AiReasoningEffort; label: string }> = [
  { value: "low", label: "低（更快）" },
  { value: "medium", label: "中（均衡）" },
  { value: "high", label: "高（更深入）" },
  { value: "xhigh", label: "极高（最慢）" },
  { value: "max", label: "最大（最难问题）" }
];
