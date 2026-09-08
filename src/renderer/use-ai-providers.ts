import { useCallback, useEffect, useState } from "react";
import type { AiProviderSettings } from "../shared/types";
import { useAsyncAction } from "./use-async-action";

/** A view-owned snapshot of public provider metadata. Selection and writes
 * belong to consumers; changing a selection never starts discovery. */
export function useAiProviders({ autoLoad = true }: { autoLoad?: boolean } = {}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [ready, setReady] = useState(false);
  const { busy, error, run } = useAsyncAction();
  const reload = useCallback(async () => {
    let result: AiProviderSettings[] | undefined;
    await run(async (isCurrent) => {
      setReady(false);
      const next = await window.reader.listAiProviders();
      if (!isCurrent()) return;
      if (!next.length) throw new Error("没有可用的 AI 服务，请重新读取配置。");
      setProviders(next);
      setReady(true);
      result = next;
    });
    return result;
  }, [run]);
  useEffect(() => { if (autoLoad) void reload(); }, [autoLoad, reload]);
  const status = busy || (!ready && !error) ? "loading" : error ? "error" : "ready";
  return { providers, status, error, reload } as const;
}
