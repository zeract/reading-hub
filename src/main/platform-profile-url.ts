import { assertPublicUrl } from "../shared/url";

const XIAOHONGSHU_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);

export type XiaohongshuProfileTarget = { url: string; profileId: string };

/**
 * Only profile pages are accepted. We never turn short links, note URLs or
 * browser sessions into a subscription target, which avoids importing a
 * transient tracking token or bypassing Xiaohongshu's access controls.
 */
export function parseXiaohongshuProfileUrl(rawUrl: string): XiaohongshuProfileTarget {
  const url = assertPublicUrl(rawUrl);
  if (!XIAOHONGSHU_HOSTS.has(url.hostname.toLowerCase())) throw new Error("请输入小红书公开博主主页地址。");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "user" || segments[1] !== "profile" || !/^[A-Za-z0-9_-]{4,160}$/.test(segments[2])) {
    throw new Error("请输入小红书博主主页，例如 https://www.xiaohongshu.com/user/profile/用户ID。");
  }
  return { url: `https://www.xiaohongshu.com/user/profile/${segments[2]}`, profileId: segments[2] };
}
