/** Formats a bounded network/document size without exposing implementation detail to UI callers. */
export function formatByteLimit(bytes: number): string {
  if (bytes < 1_000_000) return `${bytes} B`;
  const megabytes = bytes / 1_000_000;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1).replace(/\.0$/, "")} MB`;
}
