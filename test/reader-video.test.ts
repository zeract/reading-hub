import { afterEach, expect, it, vi } from "vitest";
import { load } from "cheerio";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { downloadReaderVideo, MAX_READER_VIDEO_BYTES } from "../src/main/reader-video";
import { extractReaderArticle } from "../src/main/article-reader";
import type { RobotsPolicy } from "../src/main/robots";
import type { Entry } from "../src/shared/types";
const robots = { assertAllowed: vi.fn(async () => undefined) };
const url = "https://example.com/clip.webm";
const download = (signal?: AbortSignal) => downloadReaderVideo(url, robots as unknown as RobotsPolicy, signal);
afterEach(() => { vi.clearAllMocks(); network.fetch.mockReset(); vi.useRealTimers(); });
it("replaces publisher video with an inert click-to-load block and preserves its caption", () => {
  const page = "https://example.com/article";
  const article = extractReaderArticle(`<article><p>${"Synthetic prose. ".repeat(50)}</p><figure><video autoplay muted loop poster="/poster.jpg" onplay="alert(1)"><source src="/clip.webm" type="video/webm"><source src="https://127.0.0.1/private.mp4">Your browser does not support the video tag.</video><figcaption>Figure 2 — Explanation.</figcaption></figure></article>`, page, { id: "fixture", url: page, title: "Fixture" } as Entry)!.article;
  const $ = load(article.contentHtml);
  expect($("video")).toHaveLength(1);
  expect($("video").attr("src")).toBeUndefined();
  expect($("video").attr("data-reader-video-sources")).toBe(JSON.stringify([url]));
  expect($("video").attr("preload")).toBe("none");
  expect($("button").text()).toBe("加载视频");
  expect($("figcaption").text()).toBe("Figure 2 — Explanation.");
  expect(article.contentHtml).not.toMatch(/autoplay|onplay|poster|does not support|127\.0\.0\.1/);
});
it.each(["video/webm", "video/mp4"])("accepts %s without credentials, cookies or origin scripts", async contentType => {
  network.fetch.mockResolvedValue(new Response(Uint8Array.of(1, 2, 3), { headers: { "content-type": contentType } }));
  expect(await download()).toMatchObject({ contentType, bytes: Uint8Array.of(1, 2, 3) });
  expect(network.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: "omit", redirect: "manual" }));
  expect(robots.assertAllowed).toHaveBeenCalledWith(url, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
it.each(["http://public.example/video", "https://127.0.0.1/video", "file:///tmp/video"])("rejects redirect to %s before requesting it", async location => {
  network.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
  await expect(download()).rejects.toThrow();
  expect(network.fetch).toHaveBeenCalledTimes(1);
});
it.each(["text/html", "application/vnd.apple.mpegurl"])("rejects unsupported MIME %s and cancels its body", async contentType => {
  const cancel = vi.fn();
  network.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": contentType } }));
  await expect(download()).rejects.toThrow("格式不支持");
  expect(cancel).toHaveBeenCalled();
});
it.each([false, true])("bounds video bytes with or without content length (%s)", async declared => {
  network.fetch.mockResolvedValue(new Response(declared ? new Uint8Array(1) : new Uint8Array(MAX_READER_VIDEO_BYTES + 1), { headers: { "content-type": "video/webm", ...(declared ? { "content-length": String(MAX_READER_VIDEO_BYTES + 1) } : {}) } }));
  await expect(download()).rejects.toThrow("超过 32 MB");
});
it("cancels a stalled download and releases its body", async () => {
  const cancel = vi.fn(), controller = new AbortController();
  network.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "video/webm" } }));
  const result = download(controller.signal).catch(error => error);
  await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1));
  controller.abort(new Error("fixture cancel"));
  expect((await result).message).toBe("fixture cancel");
  expect(cancel).toHaveBeenCalled();
});
it("enforces a total deadline even before response headers", async () => {
  vi.useFakeTimers(); network.fetch.mockImplementation(() => new Promise(() => undefined));
  const result = download().catch(error => error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await result).message).toContain("视频加载超时");
  expect(vi.getTimerCount()).toBe(0);
});
it("does not fetch a robots-disallowed video", async () => {
  robots.assertAllowed.mockRejectedValueOnce(new Error("robots denied"));
  await expect(download()).rejects.toThrow("robots denied");
  expect(network.fetch).not.toHaveBeenCalled();
});
