import { useCallback, useEffect, useRef, useState } from "react";
import type { AiStreamEvent, AiStreamRequest } from "../shared/types";
import { cancelScheduledAnimationFrame, scheduleAnimationFrame } from "./animation-frame";
import { errorMessage } from "./errors";

/**
 * Pairs one renderer-initiated request with main-process stream events. The
 * identifier is not a credential and is never persisted.
 */
export function newAiRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

/** Batch only the active request; terminal events flush even without a paint. */
export function useAiStreamSubscription(
  listener: (event: AiStreamEvent) => void,
  getActiveRequestId: () => string | undefined
) {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  const activeRef = useRef(getActiveRequestId);
  activeRef.current = getActiveRequestId;
  const pending = useRef<Extract<AiStreamEvent, { type: "delta" }> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    cancelScheduledAnimationFrame(frame.current);
    frame.current = undefined;
    pending.current = undefined;
  }, []);
  const flush = useCallback(() => {
    const event = pending.current;
    clear();
    if (event && event.requestId === activeRef.current()) listenerRef.current(event);
  }, [clear]);
  const receive = useCallback((event: AiStreamEvent) => {
    if (event.requestId !== activeRef.current()) return;
    if (event.type !== "delta") {
      flush();
      listenerRef.current(event);
      return;
    }
    const previous = pending.current;
    pending.current = previous?.requestId === event.requestId
      ? { ...event, text: previous.text + event.text }
      : event;
    if (frame.current === undefined) frame.current = scheduleAnimationFrame(flush);
  }, [flush]);
  const fail = useCallback((requestId: string, message: string) => {
    receive({ type: "error", requestId, message });
  }, [receive]);

  useEffect(() => {
    const unsubscribe = window.reader.onAiStream(receive);
    return () => { unsubscribe(); clear(); };
  }, [receive, clear]);
  return { clear, fail };
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
  const { clear, fail } = useAiStreamSubscription((event) => {
    if (event.type === "delta") {
      setText((current) => current + event.text);
      return;
    }
    activeRequestId.current = undefined;
    setBusy(false);
    if (event.type === "complete") setText(event.answer.text);
    else setError(event.message);
  }, () => activeRequestId.current);

  const cancel = useCallback(() => {
    const requestId = activeRequestId.current;
    activeRequestId.current = undefined;
    clear();
    if (requestId) void window.reader.cancelAiStream(requestId).catch(() => undefined);
  }, [clear]);

  useEffect(() => () => cancel(), [cancel]);

  const reset = useCallback(() => {
    cancel();
    setText("");
    setBusy(false);
    setError(undefined);
  }, [cancel]);

  const start = useCallback(async (request: AiStreamRequest) => {
    // Guard synchronously, before React commits the busy state, so a double
    // submission cannot create two provider requests for this answer surface.
    if (activeRequestId.current) return;
    activeRequestId.current = request.requestId;
    clear();
    setText("");
    setBusy(true);
    setError(undefined);
    try {
      await window.reader.startAiStream(request);
    } catch (reason) {
      fail(request.requestId, errorMessage(reason));
    }
  }, [clear, fail]);

  return { text, busy, error, reset, start, cancel };
}
