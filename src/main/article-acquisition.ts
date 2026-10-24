import { readerFailureDiagnostic, type ReaderDiagnostic } from "./reader-diagnostics";

export const MAX_ACQUISITION_ATTEMPTS = 3;
export const TRANSIENT_ACQUISITION_FAILURES = ["network", "robots_unavailable", "timeout", "http_408", "http_429", "http_500", "http_502", "http_503", "http_504"] as const;

function diagnosticCode(diagnostic: ReaderDiagnostic): string {
  return diagnostic.status === undefined ? diagnostic.reason : `http_${diagnostic.status}`;
}

export function acquisitionFailure(error: unknown): string {
  return diagnosticCode(readerFailureDiagnostic("static", error));
}

/** A readable Feed must not erase why the original was unavailable. */
export function fallbackAcquisitionFailure(diagnostics: ReaderDiagnostic[]): string {
  const original = diagnostics.filter(diagnostic => diagnostic.stage !== "feed");
  const denied = original.find(diagnostic => ["access_challenge", "robots_disallowed"].includes(diagnostic.reason)
    || diagnostic.status !== undefined && [401, 403, 404, 410].includes(diagnostic.status));
  const transient = original.find(diagnostic => TRANSIENT_ACQUISITION_FAILURES.includes(diagnosticCode(diagnostic) as typeof TRANSIENT_ACQUISITION_FAILURES[number]));
  return denied ? diagnosticCode(denied)
    : transient ? diagnosticCode(transient) : original.length ? diagnosticCode(original[0]) : "feed_only";
}

export function acquisitionRetryAt(failure: string | undefined, attempts: number, now = Date.now()): number | null {
  return failure && TRANSIENT_ACQUISITION_FAILURES.includes(failure as typeof TRANSIENT_ACQUISITION_FAILURES[number]) && attempts < MAX_ACQUISITION_ATTEMPTS
    ? now + (attempts <= 1 ? 60_000 : 300_000) : null;
}
