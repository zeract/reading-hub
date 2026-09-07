import type { Source, SyncResult } from "../shared/types";
import type { TextResponse, TextValidators } from "./http";

/** Undefined retains a stored validator; null explicitly clears it. A complete
 * response replaces both fields, whereas 304 only updates provided metadata.
 * A rendered response has no reusable HTTP validators. Use the transport
 * status, not SyncResult.notModified: an unchanged Feed can add archive cards. */
export function responseValidators(response?: Pick<TextResponse, "url" | "status" | "etag" | "lastModified">): Pick<SyncResult, "etag" | "lastModified" | "validatorUrl"> {
  const absent = response?.status === 304 ? undefined : null;
  return {
    etag: response?.etag ?? absent,
    lastModified: response?.lastModified ?? absent,
    validatorUrl: response?.status === 304 || response?.etag || response?.lastModified ? response?.url : null
  };
}

/** Unbound legacy validators cannot safely nominate any stored representation. */
export function sourceValidators(source: Pick<Source, "validatorUrl" | "etag" | "lastModified">): TextValidators | undefined {
  if (!source.validatorUrl || (!source.etag && !source.lastModified)) return undefined;
  return { url: source.validatorUrl, etag: source.etag, lastModified: source.lastModified };
}

/** HTTP representations differ by path and query, but never by fragment. */
export function validatorResourceUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch { return undefined; }
}
