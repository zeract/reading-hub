import { awaitWithAbort, throwIfAborted } from "./cancellation";

/** Formats a bounded network/document size without exposing implementation detail to UI callers. */
export function formatByteLimit(bytes: number): string {
  if (bytes < 1_000_000) return `${bytes} B`;
  const megabytes = bytes / 1_000_000;
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Read bytes only while the caller's per-chunk budget permits retaining them. */
export async function readResponseBytes(
  response: Response,
  checkLimit: (chunk: Uint8Array, receivedBytes: number) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  // Own compact slabs instead of retaining arbitrarily many transport views
  // (a one-byte subarray can pin a much larger underlying allocation).
  const slabBytes = 64 * 1024;
  let slab: Uint8Array | undefined;
  let used = 0;
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      throwIfAborted(signal);
      if (done) break;
      if (!value) continue;
      receivedBytes += value.byteLength;
      checkLimit(value, receivedBytes);
      let offset = 0;
      while (offset < value.byteLength) {
        if (!slab || used === slab.byteLength) {
          slab = new Uint8Array(slabBytes);
          used = 0;
          chunks.push(slab);
        }
        const length = Math.min(slab.byteLength - used, value.byteLength - offset);
        slab.set(value.subarray(offset, offset + length), used);
        used += length;
        offset += length;
      }
    }
  } catch (error) {
    // Cleanup must not prolong a timeout if the transport's cancellation hangs.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (slab && used < slab.byteLength) chunks[chunks.length - 1] = slab.subarray(0, used);
  return concatenateBytes(chunks, receivedBytes);
}

function concatenateBytes(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Release redirect/error bodies that are intentionally not consumed. */
export function discardResponseBody(response?: Response): void {
  void response?.body?.cancel().catch(() => undefined);
}
