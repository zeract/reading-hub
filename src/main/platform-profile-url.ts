import { assertPublicUrl } from "../shared/url";

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const X_RESERVED_PATHS = new Set([
  "home", "explore", "search", "notifications", "messages", "settings", "i", "intent", "share", "login", "signup", "compose"
]);
const XIAOHONGSHU_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);

export type XProfileTarget = { url: string; username: string };
export type XiaohongshuProfileTarget = { url: string; profileId: string };

/**
 * Converts a public X profile URL to the stable target used by the official
 * API. Status, search and other non-profile routes are deliberately refused.
 */
export function parseXProfileUrl(rawUrl: string): XProfileTarget {
  const url = assertPublicUrl(rawUrl);
  if (!X_HOSTS.has(url.hostname.toLowerCase())) throw new Error("请输入 x.com 或 twitter.com 的公开博主主页地址。");
  const segments = url.pathname.split("/").filter(Boolean);
  const username = segments[0]?.replace(/^@/, "");
  if (!username || segments.length !== 1 || !/^[A-Za-z0-9_]{1,15}$/.test(username) || X_RESERVED_PATHS.has(username.toLowerCase())) {
    throw new Error("请输入单个 X 博主主页，例如 https://x.com/username。");
  }
  return { url: `https://x.com/${username}`, username };
}

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
