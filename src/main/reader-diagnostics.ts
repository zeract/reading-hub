import { HttpStatusError, NetworkRequestError, ResponseTooLargeError } from "./http";
import { RenderedPageHttpError, RenderedPageTooLargeError } from "./rendered-document";
import { RobotsDisallowedError, RobotsUnreachableError, RobotsChallengeError } from "./robots";
import { AccessChallengeError } from "./access-challenge";

/** Main-process audit metadata only. Never include URLs, response text or error messages. */
export interface ReaderDiagnostic {
  stage: "static" | "render" | "feed";
  reason: "http" | "network" | "robots_disallowed" | "robots_unavailable" | "size_limit"
    | "access_challenge" | "unsupported_content" | "no_content" | "feed_entry_missing" | "feed_body_missing" | "unknown";
  status?: number;
}

export function readerFailureDiagnostic(stage: ReaderDiagnostic["stage"], error: unknown): ReaderDiagnostic {
  if (error instanceof AccessChallengeError || error instanceof RobotsChallengeError) return { stage, reason: "access_challenge" };
  if (error instanceof HttpStatusError || error instanceof RenderedPageHttpError) return { stage, reason: "http", status: error.status };
  // Unavailable policies inherit Disallowed for enforcement, but are not an explicit site prohibition.
  if (error instanceof RobotsUnreachableError) return { stage, reason: "robots_unavailable" };
  if (error instanceof RobotsDisallowedError) return { stage, reason: error.name === "RobotsDisallowedError" ? "robots_disallowed" : "unknown" };
  if (error instanceof NetworkRequestError) return { stage, reason: "network" };
  if (error instanceof ResponseTooLargeError || error instanceof RenderedPageTooLargeError) return { stage, reason: "size_limit" };
  return { stage, reason: "unknown" };
}

export function reportReaderDiagnostic(callback: ((diagnostic: ReaderDiagnostic) => void) | undefined, diagnostic: ReaderDiagnostic): void {
  // Auditing must not change fallback, cancellation or reading behavior.
  try { callback?.(diagnostic); } catch { /* optional observer */ }
}
