import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";

const hooks = vi.hoisted(() => ({
  afterStat: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => void) | undefined,
  afterClose: undefined as (() => void) | undefined,
  handles: [] as any[]
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const stat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    handle.stat = vi.fn(async () => {
      const metadata = await stat();
      await hooks.afterStat?.();
      return metadata;
    }) as any;
    handle.read = vi.fn(async (...readArgs: any[]) => {
      const result = await (read as any)(...readArgs);
      hooks.afterRead?.();
      return result;
    }) as any;
    const close = handle.close.bind(handle);
    handle.close = vi.fn(async () => { await close(); hooks.afterClose?.(); });
    hooks.handles.push(handle);
    return handle;
  }) };
});
import { readOpmlFile } from "../src/main/opml-file";

let directory: string;
let path: string;
beforeEach(async () => {
  hooks.afterStat = undefined; hooks.afterRead = undefined; hooks.afterClose = undefined; hooks.handles.length = 0;
  directory = await mkdtemp(join(tmpdir(), "reading-hub-opml-"));
  path = join(directory, "fixture.opml");
});
afterEach(async () => { await rm(directory, { recursive: true }); });

describe("bounded OPML file reading", () => {
  it("preserves UTF-8 text including a BOM", async () => {
    const text = '\uFEFF<opml><body><outline text="中文" xmlUrl="https://example.com/feed"/></body></opml>';
    await writeFile(path, text);
    expect(await readOpmlFile(path)).toBe(text);
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it.each([2_000_000, 2_000_001])("enforces the file size boundary at %i bytes", async (size) => {
    await writeFile(path, "x".repeat(size));
    if (size === 2_000_000) expect((await readOpmlFile(path)).length).toBe(size);
    else await expect(readOpmlFile(path)).rejects.toThrow("2 MB");
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("enforces the read limit when a real file grows after stat", async () => {
    await writeFile(path, "small");
    hooks.afterStat = async () => { await writeFile(path, "x".repeat(2_000_001)); };
    await expect(readOpmlFile(path)).rejects.toThrow("2 MB");
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("keeps reading the selected handle if its path is replaced after stat", async () => {
    await writeFile(path, "original");
    hooks.afterStat = async () => {
      await rename(path, join(directory, "original.opml"));
      await writeFile(path, "replacement");
    };
    expect(await readOpmlFile(path)).toBe("original");
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("rejects a symbolic link without reading the target", async () => {
    const target = join(directory, "target.opml");
    await writeFile(target, "fixture");
    await symlink(target, path);
    await expect(readOpmlFile(path)).rejects.toThrow("无法读取 OPML 文件");
    expect(hooks.handles).toHaveLength(0);
  });

  it("rejects a directory and closes its handle", async () => {
    await expect(readOpmlFile(directory)).rejects.toThrow("普通文件");
    expect(hooks.handles[0].read).not.toHaveBeenCalled();
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("rejects a FIFO without waiting for a writer", async () => {
    execFileSync("mkfifo", [path]);
    await expect(readOpmlFile(path)).rejects.toThrow("普通文件");
    expect(hooks.handles[0].read).not.toHaveBeenCalled();
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("closes the handle when cancelled after a native read", async () => {
    await writeFile(path, "fixture");
    const controller = new AbortController();
    hooks.afterRead = () => controller.abort(new Error("cancel import"));
    await expect(readOpmlFile(path, controller.signal)).rejects.toThrow("cancel import");
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });

  it("does not open a cancelled request or expose missing-file paths", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel import"));
    await expect(readOpmlFile(path, controller.signal)).rejects.toThrow("cancel import");
    await expect(readOpmlFile(path)).rejects.toThrow("无法读取 OPML 文件，请确认文件存在且可读取后重试。");
    expect(hooks.handles).toHaveLength(0);
  });

  it("preserves cancellation received while the file handle is closing", async () => {
    await writeFile(path, "fixture");
    const controller = new AbortController();
    hooks.afterClose = () => controller.abort(new Error("cancel while closing"));
    await expect(readOpmlFile(path, controller.signal)).rejects.toThrow("cancel while closing");
    expect(hooks.handles[0].close).toHaveBeenCalledTimes(1);
  });
});
