import { describe, expect, it, vi } from "vitest";
import { ArticleReader } from "../src/main/article-reader";
import type { Entry, ReaderArticle } from "../src/shared/types";
const entry: Entry = { id: "one", sourceId: "source", url: "https://example.com/one", canonicalUrl: "https://example.com/one", title: "One", contentHash: "one", createdAt: 1, read: false, favorite: false };

describe("reader extraction cancellation", () => {
  it.each(["static", "rendered"])("stops waiting for %s extraction and cannot publish late language metadata", async (path) => {
    const renderer = { render: vi.fn(async () => "rendered fixture") };
    const reader = new ArticleReader({ getText: vi.fn(async () => ({ text: "fixture", url: entry.url })) } as never, renderer);
    const article: ReaderArticle = { entryId: entry.id, title: "One", url: entry.url, renderProfile: "standard", contentHtml: "<p>fixture</p>", languageVariants: [
      { language: "en", label: "English", url: entry.url }, { language: "zh", label: "中文", url: "https://example.com/zh" }
    ] };
    let finish!: (value: unknown) => void;
    const extract = vi.spyOn(reader as any, "extractWithMathFallback").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    if (path === "rendered") extract.mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    let settled = false;
    const pending = reader.read(entry, undefined, { signal: controller.signal }).then(() => { settled = true; return "unexpected success"; }, (error) => { settled = true; return error.message; });
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(path === "rendered" ? 2 : 1));
    controller.abort(new Error("leave extraction"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    try { expect(settled).toBe(true); }
    finally { finish({ article, textLength: 500 }); await pending; }
    expect(await pending).toBe("leave extraction");
    await expect(reader.readLanguageVariant(entry, undefined, "https://example.com/zh")).rejects.toThrow("已过期或不可用");
    expect(renderer.render).toHaveBeenCalledTimes(path === "rendered" ? 1 : 0);
  });
});
