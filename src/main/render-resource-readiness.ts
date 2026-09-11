import type { WebRequest } from "electron";
import { delayWithAbort, throwIfAborted } from "./cancellation";

const QUIET_MS = 800;
const MAX_WAIT_MS = 12_000;
const CONTENT_RESOURCES = new Set(["script", "stylesheet", "xhr"]);

/** Hydration depends on async scripts and data, not just DOMContentLoaded.
 * Images/fonts/media must not hold an otherwise usable document hostage. */
export function observeRenderResources(request?: Pick<WebRequest, "onBeforeRequest" | "onCompleted" | "onErrorOccurred">) {
  const pending = new Set<number>();
  let changedAt = Date.now();
  request?.onBeforeRequest((details, callback) => {
    if (CONTENT_RESOURCES.has(details.resourceType)) {
      pending.add(details.id);
      changedAt = Date.now();
    }
    callback({});
  });
  const finish = (details: { id: number }) => {
    if (pending.delete(details.id)) changedAt = Date.now();
  };
  request?.onCompleted(finish);
  request?.onErrorOccurred(finish);
  return {
    async wait(signal?: AbortSignal): Promise<void> {
      const started = Date.now();
      changedAt = Math.max(changedAt, started);
      while (Date.now() - started < MAX_WAIT_MS) {
        throwIfAborted(signal);
        if (!pending.size && Date.now() - changedAt >= QUIET_MS) return;
        await delayWithAbort(100, signal);
      }
      // The task's existing snapshot/HTML contracts still decide whether the
      // bounded result is usable; an unending analytics request is not proof
      // that the already-rendered article is unavailable.
    },
    dispose() {
      request?.onBeforeRequest(null);
      request?.onCompleted(null);
      request?.onErrorOccurred(null);
      pending.clear();
    }
  };
}
