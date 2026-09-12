// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useReaderVideos } from "../src/renderer/use-reader-videos";
import type { ReaderArticle } from "../src/shared/types";
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const article = { contentHtml: "fixture" } as ReaderArticle;
const markup = [1, 2].map(n => `<div><video data-reader-video-sources='["https://example.com/${n}.webm"]'></video><button data-reader-video-load>加载视频</button><span role="status"></span></div>`).join("");
function Fixture({ version = article }) { const ref = useRef<HTMLDivElement>(null); useReaderVideos("fixture", version, ref); return <div ref={ref} dangerouslySetInnerHTML={{ __html: markup }} />; }
const load = vi.fn(), cancel = vi.fn(async () => undefined), revoke = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:fixture") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  Object.defineProperty(window, "reader", { configurable: true, value: { loadArticleVideo: load, cancelArticleVideo: cancel } });
  load.mockResolvedValue({ bytes: Uint8Array.of(1), contentType: "video/webm" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const click = (index = 0) => act(async () => host.querySelectorAll<HTMLButtonElement>("button")[index].click());
it("loads on demand only and releases the previous clip and document", async () => {
  await act(async () => root.render(<Fixture />));
  expect(load).not.toHaveBeenCalled();
  await click();
  expect(host.querySelector("video")?.getAttribute("src")).toBe("blob:fixture");
  await click(1);
  expect(host.querySelector("video")?.hasAttribute("src")).toBe(false);
  expect(revoke).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(revoke).toHaveBeenCalledTimes(2);
});
it("ignores a late response after switching documents", async () => {
  let resolve!: (data: unknown) => void;
  load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => root.render(<Fixture />)); await click();
  await act(async () => root.render(<Fixture version={{ ...article }} />));
  await act(async () => resolve({ bytes: Uint8Array.of(1), contentType: "video/webm" }));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});
it("keeps a safe failure and allows retry without exposing remote diagnostics", async () => {
  load.mockRejectedValueOnce(new Error("private details"));
  await act(async () => root.render(<Fixture />)); await click();
  expect(host.textContent).toContain("原文中观看");
  expect(host.textContent).not.toContain("private details");
  await click(); expect(host.querySelector("video")?.hasAttribute("src")).toBe(true);
});
