/**
 * A publication timestamp represents content that is already public.  Small
 * clock and timezone differences are normal, but a date far beyond the local
 * observation time is not trustworthy enough to place at the head of a
 * reader timeline.
 */
export const MAX_FUTURE_PUBLICATION_SKEW_MS = 48 * 60 * 60_000;

/**
 * Keeps only finite publication timestamps that are plausibly published when
 * the application observed the content.  Callers retain the entry itself and
 * use its local observation time when this returns undefined.
 */
export function sanitizePublishedAt(value: number | undefined, observedAt = Date.now()): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value <= observedAt + MAX_FUTURE_PUBLICATION_SKEW_MS ? value : undefined;
}

/** Used by persistence upgrades to repair timestamps written by older builds. */
export function isFuturePublishedAt(value: number | null | undefined, observedAt = Date.now()): boolean {
  return typeof value === "number" && Number.isFinite(value)
    && value > observedAt + MAX_FUTURE_PUBLICATION_SKEW_MS;
}
