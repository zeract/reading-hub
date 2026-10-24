/** Pure persistence policy: usable from both Electron and its storage worker. */
export const MAX_ACQUISITION_ATTEMPTS = 3;
export const TRANSIENT_ACQUISITION_FAILURES = ["network", "robots_unavailable", "timeout", "http_408", "http_429", "http_500", "http_502", "http_503", "http_504"] as const;
export function acquisitionRetryAt(failure: string | undefined, attempts: number, now = Date.now()): number | null {
  return failure && TRANSIENT_ACQUISITION_FAILURES.includes(failure as typeof TRANSIENT_ACQUISITION_FAILURES[number]) && attempts < MAX_ACQUISITION_ATTEMPTS
    ? now + (attempts <= 1 ? 60_000 : 300_000) : null;
}
