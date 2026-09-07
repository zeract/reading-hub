import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readResponseBytes } from "../src/main/byte-limit";
import { PublicHttpClient } from "../src/main/http";

const network = vi.hoisted(() => ({ fetch: vi.fn(), scans: 0, scannedCharacters: 0 }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
vi.mock("../src/main/feed", async (original) => {
  const actual = await original<typeof import("../src/main/feed")>();
  return { ...actual, hasFeedSignature: (text: string) => {
    network.scans++; network.scannedCharacters += text.length;
    return actual.hasFeedSignature(text);
  } };
});
afterEach(() => { vi.clearAllMocks(); network.scans = 0; network.scannedCharacters = 0; });
const client = () => new PublicHttpClient({ assertAllowed: vi.fn(async () => undefined) } as never);

function fragmentedBody(text: string) {
  // Only this fixture constructs this type; heap counts cannot include other
  // transports or test workers. Each one-byte view owns a larger backing store.
  class TransportChunk extends Uint8Array {}
  let index = 0, retained = -1;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === bytes.length) {
        retained = queryObjects(TransportChunk, { format: "count" });
        controller.close();
        return;
      }
      const chunk = new TransportChunk(new ArrayBuffer(4096), 32, 1);
      chunk[0] = bytes[index++];
      controller.enqueue(chunk);
    }
  }, { highWaterMark: 0 });
  return { body, retained: () => retained };
}

describe("response fragmentation budgets", () => {
  it("releases consumed transport views before EOF while preserving exact bytes", async () => {
    const expected = "分块 🧪 café\n".repeat(80);
    const fixture = fragmentedBody(expected);
    const result = await readResponseBytes(new Response(fixture.body), (_chunk, size) => {
      if (size > 8000) throw new Error("fixture limit");
    });
    expect(new TextDecoder().decode(result)).toBe(expected);
    expect(result.buffer.byteLength).toBe(result.byteLength);
    // A current read/pull may still own its most recent view; older views must
    // be collectible during the transfer, not only after the full response.
    expect(fixture.retained()).toBeLessThanOrEqual(2);
    expect(fixture.body.locked).toBe(false);
  });

  it("keeps an owned prefix and bounds signature rescans for tiny non-Feed chunks", async () => {
    const expected = "ordinary response ".repeat(100);
    const fixture = fragmentedBody(expected);
    network.fetch.mockResolvedValueOnce(new Response(fixture.body, { headers: { "content-type": "text/plain" } }));
    expect((await client().getText("https://example.com/fragmented")).text).toBe(expected);
    expect(fixture.retained()).toBeLessThanOrEqual(2);
    expect(network.scans).toBeLessThan(20);
    expect(network.scannedCharacters).toBeLessThan(expected.length * 3);
  });

  it("checks the prefix at the page budget boundary before granting the larger Feed budget", async () => {
    const text = '<rss version="2.0"><channel><title>Fixture</title></channel></rss>';
    const fixture = fragmentedBody(text);
    network.fetch.mockResolvedValueOnce(new Response(fixture.body, { headers: { "content-type": "text/plain" } }));
    expect((await client().getText("https://example.com/feed", undefined, { maxBytes: 6, maxFeedBytes: 100 })).text).toBe(text);
    expect(network.scans).toBeLessThan(10);
  });

  it.each([true, false])("keeps the fixed sniff window authoritative (signature inside=%s)", async (inside) => {
    const offset = inside ? 63_990 : 64_001;
    const text = `<!--${"x".repeat(offset - 7)}--><rss><channel>${"y".repeat(100)}</channel></rss>`;
    const bytes = new TextEncoder().encode(text);
    let position = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position >= bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(position, position + 1013));
        position += 1013;
      }, cancel
    }, { highWaterMark: 0 });
    network.fetch.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "application/rss+xml" } }));
    const request = client().getText("https://example.com/late-signature", undefined, { maxBytes: 64_010, maxFeedBytes: 65_000 });
    if (inside) {
      expect((await request).text).toBe(text);
      expect(cancel).not.toHaveBeenCalled();
    } else {
      await expect(request).rejects.toMatchObject({ name: "ResponseTooLargeError", maxBytes: 64_010, documentKind: "page" });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    expect(body.locked).toBe(false);
    expect(network.scans).toBeLessThan(20);
    expect(network.scannedCharacters).toBeLessThan(64_000 * 4);
  });
});
