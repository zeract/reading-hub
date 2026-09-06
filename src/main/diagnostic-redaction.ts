/**
 * Remote errors and audit reports reach SQLite, the UI, terminals and issue trackers.
 * Subscription endpoints can contain bearer-style query tokens, so they must
 * never be emitted verbatim even though the local database may use them as a
 * user-provided feed URL.
 */
export function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    const hadQuery = url.search.length > 0;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname}${hadQuery ? "?…" : ""}`;
  } catch {
    return "[redacted URL]";
  }
}

export function redactDiagnosticMessage(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s'"<>]+/gi, (url) => redactDiagnosticUrl(url))
    .replace(/\b(access[_-]?token|api[_-]?key|client[_-]?secret|token|secret|signature|sig)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
}
