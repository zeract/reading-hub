import { awaitWithAbort, throwIfAborted } from "./cancellation";
import { discardResponseBody } from "./byte-limit";

/**
 * Await headers with cancellation even when a transport ignores its signal.
 * Dispose late responses; the caller owns every successfully returned body
 * and must keep its deadline alive through consumption and cleanup.
 */
export async function fetchResponse(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit
): Promise<Response> {
  const signal = init.signal ?? undefined;
  throwIfAborted(signal);
  let unclaimed: Response | undefined;
  const discardUnclaimed = () => {
    discardResponseBody(unclaimed);
    unclaimed = undefined;
  };
  const pending = fetcher(url, init).then((response) => {
    unclaimed = response;
    if (signal?.aborted) discardUnclaimed();
    throwIfAborted(signal);
    return response;
  });
  try {
    const response = await awaitWithAbort(pending, signal);
    throwIfAborted(signal);
    unclaimed = undefined;
    return response;
  } catch (error) {
    // Cancellation can win after headers arrive but before the wait's
    // continuation takes ownership; that body needs cleanup as well.
    discardUnclaimed();
    throw error;
  }
}
