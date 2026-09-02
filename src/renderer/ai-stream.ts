import { useCallback, useEffect, useRef, useState } from "react";
import type { AiStreamEvent, AiStreamRequest } from "../shared/types";
import { errorMessage } from "./errors";

/**
 * Pairs one renderer-initiated request with main-process stream events. The
 * identifier is not a credential and is never persisted.
 */
export function newAiRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

/** Keep every AI surface on the same scoped IPC subscription contract. */
export function useAiStreamSubscription(listener: (event: AiStreamEvent) => void): void {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => window.reader.onAiStream((event) => listenerRef.current(event)), []);
}

/**
 * Minimal, ephemeral streamed-text state for a single AI task. Previous
 * request events are ignored, so switching article, provider, or task cannot
 * overwrite a newer result.
 */
export function useAiTextStream() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequestId = useRef<string | undefined>(undefined);

  useEffect(() => () => {
    // The provider request may finish in the main process after this surface
    // closes, but no late event or rejected invoke may update an unmounted UI.
    activeRequestId.current = undefined;
  }, []);

  useAiStreamSubscription((event) => {
    if (activeRequestId.current !== event.requestId) return;
    if (event.type === "delta") {
      setText((current) => `${current}${event.text}`);
      return;
    }
    activeRequestId.current = undefined;
    setBusy(false);
    if (event.type === "complete") {
      setText(event.answer.text);
      return;
    }
    setError(event.message);
  });

  const reset = useCallback(() => {
    activeRequestId.current = undefined;
    setText("");
    setBusy(false);
    setError(undefined);
  }, []);

  const start = useCallback(async (request: AiStreamRequest) => {
    // A double-click must not create two billable/provider requests for the
    // same visible answer surface. Explicit reset is required before retrying.
    if (activeRequestId.current) return;
    activeRequestId.current = request.requestId;
    setText("");
    setBusy(true);
    setError(undefined);
    try {
      await window.reader.startAiStream(request);
    } catch (reason) {
      if (activeRequestId.current !== request.requestId) return;
      activeRequestId.current = undefined;
      setBusy(false);
      setError(errorMessage(reason));
    }
  }, []);

  return { text, busy, error, reset, start };
}
