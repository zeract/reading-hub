import type { useAiProviders } from "./use-ai-providers";

export function AiProviderFeedback({ status, error, onRetry, retryDisabled = false, errorPrefix = "无法读取 AI 服务配置。" }: {
  status: ReturnType<typeof useAiProviders>["status"];
  error?: string;
  onRetry: () => void;
  retryDisabled?: boolean;
  errorPrefix?: string;
}) {
  if (status === "ready") return null;
  return <div className="ai-provider-feedback">
    {status === "loading" ? <p role="status">正在读取 AI 服务配置…</p> : <>
      <p className="ai-provider-error" role="alert" tabIndex={0}>{errorPrefix}{error}</p>
      <button type="button" className="action-button" disabled={retryDisabled} onClick={onRetry}>重新读取</button>
    </>}
  </div>;
}
