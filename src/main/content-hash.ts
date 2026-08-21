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
