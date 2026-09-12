import { assertPublicUrl } from "../shared/url";
import { withRequestTimeout, throwIfAborted } from "./cancellation";
import { discardResponseBody, readResponseBytes } from "./byte-limit";
import { fetchResponse } from "./fetch-response";
import { chromiumFetch } from "./network";
import type { RobotsPolicy } from "./robots";

export const MAX_READER_VIDEO_BYTES = 32 * 1024 * 1024;
export interface ReaderVideoData { bytes: Uint8Array; contentType: string }
const publicHttps = (value: string) => {
  const url = assertPublicUrl(value);
  if (url.protocol !== "https:") throw new Error("视频仅支持公共 HTTPS 地址，请在原文中观看。");
  return url.toString();
};

/** User-initiated short clips only; never a general streaming/browser proxy. */
export async function downloadReaderVideo(rawUrl: string, robots: RobotsPolicy, signal?: AbortSignal): Promise<ReaderVideoData> {
  let url = publicHttps(rawUrl);
  const request = withRequestTimeout(signal, 60_000, "视频加载超时，请重试或在原文中观看。");
  try {
    for (let hop = 0; hop <= 5; hop++) {
      throwIfAborted(request.signal);
      await robots.assertAllowed(url, { signal: request.signal });
      let response: Response | undefined;
      try {
        response = await fetchResponse(chromiumFetch, url, { credentials: "omit", redirect: "manual", signal: request.signal, headers: { Accept: "video/webm,video/mp4", "User-Agent": "ReadingHub/0.1 (+local reader)" } });
        const location = response.headers.get("location");
        if (location && response.status >= 300 && response.status < 400) {
          if (hop === 5) throw new Error("视频重定向次数过多，请在原文中观看。");
          url = publicHttps(new URL(location, url).toString());
          continue;
        }
        if (!response.ok) throw new Error(`视频请求失败（HTTP ${response.status}），请在原文中观看。`);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
        if (!["video/webm", "video/mp4"].includes(contentType)) throw new Error("视频格式不支持，请在原文中观看。");
        const tooLarge = () => new Error("视频超过 32 MB，请在原文中观看。");
        if (Number(response.headers.get("content-length")) > MAX_READER_VIDEO_BYTES) throw tooLarge();
        const bytes = await readResponseBytes(response, (_chunk, size) => { if (size > MAX_READER_VIDEO_BYTES) throw tooLarge(); }, request.signal);
        throwIfAborted(request.signal);
        if (!bytes.length) throw new Error("视频内容为空，请在原文中观看。");
        return { bytes, contentType };
      } finally { discardResponseBody(response); }
    }
    throw new Error("视频无法加载，请在原文中观看。");
  } finally { request.dispose(); }
}
