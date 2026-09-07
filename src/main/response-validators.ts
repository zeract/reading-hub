import type { SyncResult } from "../shared/types";
import type { TextResponse } from "./http";

/** Undefined retains a stored validator; null explicitly clears it. A complete
 * response replaces both fields, whereas 304 only updates provided metadata.
 * A rendered response has no reusable HTTP validators. Use the transport
 * status, not SyncResult.notModified: an unchanged Feed can add archive cards. */
export function responseValidators(response?: Pick<TextResponse, "status" | "etag" | "lastModified">): Pick<SyncResult, "etag" | "lastModified"> {
  const absent = response?.status === 304 ? undefined : null;
  return { etag: response?.etag ?? absent, lastModified: response?.lastModified ?? absent };
}
