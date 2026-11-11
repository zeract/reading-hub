import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadingDatabase } from "../src/main/database";
import { auditLocalReader, inspectSavedReader, inspectFirstImage, type ReaderAuditResult } from "../src/main/reader-audit";
import { articleDocumentFromHtml } from "../src/main/article-document";
const article = {
  entryId: "entry", title: "Stored article", url: "https://publisher.example/final/post", renderProfile: "standard" as const,
  contentHtml: "", document: articleDocumentFromHtml('<p>Local body</p><img src="https://media.example/one.png"><img src="https://media.example/two.png">'),
  coverImageUrl: "https://media.example/cover.png"
};
it("checks every owned image including cover without calling a remote transport", () => {
  const store = { read: vi.fn(() => article), imageBytes: vi.fn((_id: string, url: string) => url.endsWith("one.png") ? { mime: "image/png", bytes: Buffer.from("saved") } : undefined) };
  expect(inspectSavedReader(store, "entry")).toEqual({ document: "saved", quality: "original", images: { total: 3, stored: 1, missing: 2, invalid: 0 } });
  expect(store.imageBytes).toHaveBeenCalledTimes(3);
});
it("keeps a missing document separate from a document whose stored data is invalid", () => {
  expect(inspectSavedReader({ read: () => undefined, imageBytes: vi.fn() }, "entry")).toEqual({ document: "missing" });
  const error = new Error("private body or secret in corrupt snapshot");
  expect(inspectSavedReader({ read: () => { throw error; }, imageBytes: vi.fn() }, "entry")).toEqual({ document: "invalid" });
});
it("does not equate Feed content or invalid image bytes with full offline original availability", () => {
  expect(inspectSavedReader({ read: () => ({ ...article, contentMode: "feed_body" }), imageBytes: () => ({ mime: "image/png", bytes: Buffer.alloc(0) }) }, "entry"))
    .toEqual({ document: "saved", quality: "feed", images: { total: 3, stored: 0, missing: 0, invalid: 3 } });
});
it("isolates an unreadable media record without hiding the rest of the saved body", () => {
  expect(inspectSavedReader({ read: () => article, imageBytes: () => { throw new Error("storage error"); } }, "entry"))
    .toMatchObject({ document: "saved", images: { invalid: 3 } });
});
it("uses the acquired document URL as image referrer, as durable media does", async () => {
  const getImageDataUrl = vi.fn().mockResolvedValue("data:image/png;base64,AA==");
  const result: ReaderAuditResult = { source: "Test", kind: "rss", issues: [] };
  await inspectFirstImage({ getImageDataUrl } as never, { ...article, contentHtml: '<img src="https://media.example/one.png">' }, result);
  expect(getImageDataUrl).toHaveBeenCalledWith("https://media.example/one.png", article.url, { signal: undefined });
  expect(result.issues).toEqual([]);
});

it("reports saved availability before skipping an unauthorized online sample", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-local-audit-"));
  const file = join(directory, "library.sqlite");
  const db = new ReadingDatabase(file);
  try {
    const source = db.createSource({ title: "Authorized source", url: "https://www.zhihu.com/follow", kind: "zhihu_follow", pollingEnabled: true });
    db.saveEntries([{ id: "entry", sourceId: source.id, canonicalUrl: article.url, url: article.url, title: article.title, contentHash: "fixture", read: false, favorite: false, createdAt: 1 }]);
    db.articles.save("entry", article);
    db.articles.saveImage("entry", "https://media.example/one.png", "data:image/png;base64,AA==");
    const before = db.getEntry("entry");
    const results = await auditLocalReader(file, { sampleDelayMs: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "skipped", local: { document: "saved", quality: "original", images: { total: 3, stored: 1, missing: 2 } } });
    expect(db.getEntry("entry")).toEqual(before);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
