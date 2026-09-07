import { describe, expect, it, vi } from "vitest";
import { Utf8LineDecoder } from "../src/main/utf8-line-decoder";

describe("bounded UTF-8 lines", () => {
  it("supports mixed universal line endings across every byte boundary", () => {
    const lines: string[] = [];
    const decoder = new Utf8LineDecoder(100, (line) => lines.push(line), "universal");
    for (const byte of Buffer.from("中文\r\n\r🧪\n\r\n末尾\r")) decoder.push(Uint8Array.of(byte));
    decoder.end();
    expect(lines).toEqual(["中文", "", "🧪", "", "末尾"]);
  });

  it("preserves bare carriage returns in the default JSON-line mode", () => {
    const lines: string[] = [];
    const decoder = new Utf8LineDecoder(100, (line) => lines.push(line));
    decoder.push(Buffer.from("first\rsecond\n"));
    decoder.end();
    expect(lines).toEqual(["first\rsecond"]);
  });

  it("handles batches of CR-only blank lines and stops immediately on discard", () => {
    const lines: string[] = [];
    const decoder = new Utf8LineDecoder(100, (line) => {
      lines.push(line);
      if (lines.length === 5000) decoder.discard();
    }, "universal");
    decoder.push(Buffer.from("\r".repeat(10000)));
    decoder.end();
    expect(lines).toHaveLength(5000);
    expect(lines.every((line) => line === "")).toBe(true);
  });

  it("frames fragmented UTF-8, CRLF, blank lines and a final line without a newline", () => {
    const accept = vi.fn();
    const decoder = new Utf8LineDecoder(100, accept);
    for (const byte of Buffer.from("中文 🧪\r\n\n末尾")) decoder.push(Buffer.from([byte]));
    expect(accept.mock.calls.flat()).toEqual(["中文 🧪", ""]);
    decoder.end(); decoder.end(); decoder.push(Buffer.from("ignored\n"));
    expect(accept.mock.calls.flat()).toEqual(["中文 🧪", "", "末尾"]);
  });

  it("applies the byte limit per line rather than per chunk or decoded character", () => {
    const accept = vi.fn();
    const decoder = new Utf8LineDecoder(6, accept);
    decoder.push(Buffer.from("中文\n中文\n中文\n"));
    expect(accept).toHaveBeenCalledTimes(3);
    decoder.push(Buffer.from("中文"));
    expect(() => decoder.push(Buffer.from("x"))).toThrow("byte limit");
    decoder.end(); decoder.push(Buffer.from("later\n"));
    expect(accept).toHaveBeenCalledTimes(3);
  });

  it("discards an incomplete frame explicitly and stops callbacks during a batch", () => {
    const accept = vi.fn(() => decoder.discard());
    const decoder = new Utf8LineDecoder(100, accept);
    decoder.push(Buffer.from("first\nsecond\npartial")); decoder.end();
    expect(accept).toHaveBeenCalledExactlyOnceWith("first");
  });

  it.each([0, -1, 1.5, Infinity, NaN])("rejects an invalid capacity %s", (limit) => {
    expect(() => new Utf8LineDecoder(limit, () => undefined)).toThrow(RangeError);
  });
});
