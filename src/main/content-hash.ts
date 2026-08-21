import { createHash } from "node:crypto";

/**
 * Database identity hashing is a main-process concern. Keeping it out of the
 * shared URL module lets browser-facing code reuse URL validation without
 * Vite attempting to bundle Node's crypto implementation.
 */
export function contentHash(entry: { title: string; summary?: string; publishedAt?: number }): string {
  return createHash("sha256")
    .update(`${entry.title.trim()}\u0000${entry.publishedAt ?? ""}\u0000${entry.summary?.trim() ?? ""}`)
    .digest("hex");
}

/**
 * Some platform records have a provider-stable object identity that is more
 * precise than their visible title, timestamp, and summary. Keep that
 * identity in their hash so two distinct posts/papers never collapse merely
 * because their display metadata happens to match.
 */
export function identityContentHash(identity: string, entry: { title: string; summary?: string }): string {
  return createHash("sha256")
    .update(`${identity}\n${entry.title}\n${entry.summary || ""}`)
    .digest("hex");
}
