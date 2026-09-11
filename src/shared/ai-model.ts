/** IDs are opaque provider values, not a release-time allowlist. */
export function validAiModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(value);
}
export function validAiEffort(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}
