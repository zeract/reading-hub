/**
 * Coalesce high-frequency provider deltas to the next paint. The fallback
 * keeps renderer helpers deterministic in non-DOM test environments without
 * introducing a timer for browsers that provide animation frames.
 */
export function scheduleAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 0) as unknown as number;
}

/** Cancel a scheduled frame regardless of whether the fallback was used. */
export function cancelScheduledAnimationFrame(handle: number | undefined): void {
  if (handle === undefined) return;
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}
