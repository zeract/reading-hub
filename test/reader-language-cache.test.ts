import { afterEach, expect, it, vi } from "vitest";
import { ArticleReader } from "../src/main/article-reader";
import type { Entry } from "../src/shared/types";

const entry = (index: number): Entry => ({ id: String(index), sourceId: "fixture", title: "Fixture", url: `https://example.com/${index}/en`, canonicalUrl: `https://example.com/${index}/en`, contentHash: String(index), createdAt: 1, read: false, favorite: false });
const alternate = (index: number) => `https://example.com/${index}/zh`;
function fixture() {
  const http = { getText: vi.fn(async (url: string) => ({ url, status: 200, text: "fixture" })) };
  const reader = new ArticleReader(http as never, { render: vi.fn() } as never);
  // Keep network/extraction deterministic; exercise cache admission and lookup
  // only through the reader's public read and language-switch operations.
  vi.spyOn(reader as any, "extractWithMathFallback").mockImplementation(async (_html: unknown, url: unknown, rawEntry: unknown) => {
    const current = rawEntry as Entry;
    return { textLength: 500, article: { entryId: current.id, title: current.title, url, contentHtml: "<p>Fixture</p>", renderProfile: "standard", languageVariants: [
      { url: current.url, language: "en", label: "English" },
      { url: alternate(Number(current.id)), language: "zh", label: "中文" }
    ] } };
  });
  return { reader, http };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("can read the oldest live language metadata at full capacity", async () => {
  const { reader } = fixture();
  for (let index = 0; index < 240; index++) await reader.read(entry(index));
  await expect(reader.readLanguageVariant(entry(0), undefined, alternate(0))).resolves.toMatchObject({ url: alternate(0) });
});

it("refreshes an existing article without evicting another at full capacity", async () => {
  const { reader } = fixture();
  for (let index = 0; index < 240; index++) await reader.read(entry(index));
  await reader.read(entry(239));
  await expect(reader.readLanguageVariant(entry(0), undefined, alternate(0))).resolves.toMatchObject({ url: alternate(0) });
});

it("evicts the least recently used article only when a new one needs room", async () => {
  const { reader, http } = fixture();
  for (let index = 0; index < 240; index++) await reader.read(entry(index));
  await reader.readLanguageVariant(entry(0), undefined, alternate(0));
  await reader.read(entry(240));
  http.getText.mockClear();
  await expect(reader.readLanguageVariant(entry(1), undefined, alternate(1))).rejects.toThrow("已过期或不可用");
  expect(http.getText).not.toHaveBeenCalled();
  await expect(reader.readLanguageVariant(entry(0), undefined, alternate(0))).resolves.toMatchObject({ url: alternate(0) });
});

it("rejects expired or undeclared alternatives before network access", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const { reader, http } = fixture();
  await reader.read(entry(0));
  http.getText.mockClear();
  await expect(reader.readLanguageVariant(entry(0), undefined, "https://other.example/zh")).rejects.toThrow("已过期或不可用");
  vi.setSystemTime(Date.now() + 15 * 60_000);
  await expect(reader.readLanguageVariant(entry(0), undefined, alternate(0))).rejects.toThrow("已过期或不可用");
  expect(http.getText).not.toHaveBeenCalled();
  await reader.read(entry(0));
  await expect(reader.readLanguageVariant(entry(0), undefined, alternate(0))).resolves.toMatchObject({ url: alternate(0) });
});
