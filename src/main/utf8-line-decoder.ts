/** Frames UTF-8 on newline bytes before decoding, independently of transport
 * chunk boundaries. Only the unfinished line is retained, with a byte cap. */
export class Utf8LineDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private bytes = 0;
  private closed = false;
  private skipLineFeed = false;

  constructor(private readonly maxBytes: number, private readonly accept: (line: string) => void,
    private readonly lineEndings: "lf" | "universal" = "lf") {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Line byte limit must be a positive safe integer.");
  }

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    let start = 0;
    while (start < chunk.length && !this.closed) {
      // CR is already a complete line ending. Swallow only its paired LF,
      // including when the pair straddles transport chunks.
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (chunk[start] === 10) { start++; continue; }
      }
      let newline = -1;
      if (this.lineEndings === "universal") {
        // Search both separators in one pass; repeated indexOf searches for
        // an absent separator would rescan a CR-only/LF-only chunk per line.
        for (let index = start; index < chunk.length; index++) {
          if (chunk[index] === 10 || chunk[index] === 13) { newline = index; break; }
        }
      } else newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      if (this.bytes + length > this.maxBytes) {
        this.discard();
        throw new RangeError("Protocol line exceeds its byte limit.");
      }
      // A growing buffer also bounds allocation overhead when a producer
      // delivers one byte at a time; never retain the incoming chunk itself.
      const required = this.bytes + length;
      if (required > this.buffer.length) {
        const buffer = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(4096, this.buffer.length * 2, required)));
        this.buffer.copy(buffer, 0, 0, this.bytes);
        this.buffer = buffer;
      }
      this.buffer.set(chunk.subarray(start, end), this.bytes);
      this.bytes += length;
      if (newline < 0) return;
      this.skipLineFeed = this.lineEndings === "universal" && chunk[newline] === 13;
      this.emit();
      start = newline + 1;
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.bytes) this.emit();
  }

  discard(): void { this.closed = true; this.buffer = Buffer.alloc(0); this.bytes = 0; }

  private emit(): void {
    const line = this.buffer.toString("utf8", 0, this.bytes);
    this.buffer = Buffer.alloc(0); this.bytes = 0;
    this.accept(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}
