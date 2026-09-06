import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { throwIfAborted } from "./cancellation";

const MAX_OPML_BYTES = 2_000_000;

class InvalidOpmlFileError extends Error {
  constructor() { super("OPML 文件必须是不超过 2 MB 的普通文件。"); }
}

/** Read the selected regular file through one handle, with a runtime byte cap. */
export async function readOpmlFile(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  try {
    // NOFOLLOW preserves the existing rejection of symbolic links. NONBLOCK
    // lets us reject a substituted FIFO/device before attempting to read it.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      throwIfAborted(signal);
      const metadata = await file.stat();
      throwIfAborted(signal);
      if (!metadata.isFile() || metadata.size > MAX_OPML_BYTES) throw new InvalidOpmlFileError();
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(64 * 1024);
      let received = 0;
      while (true) {
        throwIfAborted(signal);
        // One byte beyond the limit detects growth without reading the rest.
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, MAX_OPML_BYTES + 1 - received), null);
        throwIfAborted(signal);
        if (!bytesRead) break;
        received += bytesRead;
        if (received > MAX_OPML_BYTES) throw new InvalidOpmlFileError();
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      text = Buffer.concat(chunks, received).toString("utf8");
    } finally {
      // Native file operations own the handle until they settle; cancellation
      // must not abandon a pending read or race it with a premature close.
      await file.close();
    }
    throwIfAborted(signal);
    return text;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof InvalidOpmlFileError) throw error;
    throw new Error("无法读取 OPML 文件，请确认文件存在且可读取后重试。");
  }
}
