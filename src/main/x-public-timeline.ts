import { compactText, parsePublishedAt } from "../shared/text";
import type { RawEntry } from "../shared/types";

type JsonRecord = Record<string, unknown>;

export type XPublicTimeline = {
  /** Whether the X embed response contained a recognised timeline payload. */
  recognized: boolean;
  entries: RawEntry[];
};

/**
 * X serves public profile timelines to its own embed widget from this origin.
 * This is intentionally not the private x.com web API: it needs no account,
 * cookie, guest token, browser session or script execution. The connector
 * still checks this endpoint's robots policy before every request.
 */
export function xPublicTimelineUrl(username: string): string {
  const handle = encodeURIComponent(username);
  const query = new URLSearchParams({
    dnt: "true",
    lang: "en",
    showHeader: "false",
    showReplies: "false",
    transparent: "true"
  });
  return `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?${query}`;
}

/**
 * Parse only the JSON that X has already server-rendered for its embed widget.
 * No page JavaScript is evaluated and no implicit web API request is made.
 * The payload shape has changed over time, so the mapper accepts both the
 * older `content.tweet` representation and the newer Tweet/legacy envelope.
 */
export function parsePublicXTimeline(html: string, username: string): XPublicTimeline {
  const handle = username.toLowerCase();
  const payloads = nextDataPayloads(html);
  const entries: RawEntry[] = [];
  const seen = new Set<string>();
  let recognized = false;

  for (const payload of payloads) {
    for (const timeline of timelineRecords(payload)) {
      recognized = true;
      const timelineEntries = Array.isArray(timeline.entries) ? timeline.entries : [];
      for (const value of timelineEntries) {
        if (!isRecord(value)) continue;
        const post = postFromTimelineEntry(value, handle);
        if (!post || seen.has(post.externalId || post.url)) continue;
        seen.add(post.externalId || post.url);
        entries.push(post);
      }
    }
  }
  return { recognized, entries };
}

function nextDataPayloads(html: string): unknown[] {
  const payloads: unknown[] = [];
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    if (!/\bid\s*=\s*(["'])__NEXT_DATA__\1/i.test(script[1])) continue;
    const text = script[2].trim();
    if (!text) continue;
    try {
      payloads.push(JSON.parse(text));
    } catch {
      // A malformed embed response is not interpreted as executable code.
    }
  }
  return payloads;
}

function timelineRecords(root: unknown): JsonRecord[] {
  const timelines: JsonRecord[] = [];
  const stack: unknown[] = [root];
  const visited = new Set<object>();
  while (stack.length && visited.size < 40_000) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    if (!isRecord(current) || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current.entries) && looksLikeTimeline(current.entries)) timelines.push(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return timelines;
}

function looksLikeTimeline(entries: unknown[]): boolean {
  return entries.length === 0 || entries.some((entry) => {
    if (!isRecord(entry)) return false;
    return entry.type === "tweet" || isRecord(entry.content) || isRecord(entry.itemContent);
  });
}

function postFromTimelineEntry(entry: JsonRecord, expectedUsername: string): RawEntry | undefined {
  const candidate = unwrapTweet(
    recordAt(entry, ["content", "tweet"]) ||
    recordAt(entry, ["content", "itemContent", "tweet_results", "result"]) ||
    recordAt(entry, ["itemContent", "tweet_results", "result"]) ||
    recordAt(entry, ["tweet"]) ||
    entry
  );
  if (!candidate) return undefined;

  const legacy = isRecord(candidate.legacy) ? candidate.legacy : candidate;
  const id = stringId(candidate.rest_id) || stringId(candidate.id_str) || stringId(legacy.id_str) || stringId(candidate.id) || stringId(legacy.id);
  const text = compactText(firstString(legacy, ["full_text", "text"]) || firstString(candidate, ["full_text", "text"]), 2_000);
  if (!id || !text || !looksLikeTweet(candidate, legacy)) return undefined;

  const author = tweetUsername(candidate) || tweetUsername(entry) || expectedUsername;
  if (author.toLowerCase() !== expectedUsername || !isOriginalTweet(candidate, legacy)) return undefined;
  const entities = isRecord(legacy.entities) ? legacy.entities : isRecord(candidate.entities) ? candidate.entities : {};
  const mediaEntities = isRecord(legacy.extended_entities) ? legacy.extended_entities : isRecord(candidate.extended_entities) ? candidate.extended_entities : entities;
  const externalUrl = externalUrlFromEntities(entities);
  const imageUrl = imageFromEntities(mediaEntities);
  const publishedAt = parseXPublishedAt(firstString(legacy, ["created_at"]) || firstString(candidate, ["created_at"]));
  const url = `https://x.com/${encodeURIComponent(author)}/status/${encodeURIComponent(id)}`;
  return {
    url,
    title: compactText(text.replace(/\s+/g, " "), 150) || "X 帖子",
    summary: text,
    author: `@${author}`,
    publishedAt,
    imageUrl,
    externalUrl,
    externalId: id,
    canonicalIdentity: `x:${id}`,
    observedAt: Date.now(),
    providerId: "x",
    providerLabel: "X"
  };
}

function unwrapTweet(value: JsonRecord): JsonRecord | undefined {
  if (value.__typename === "TweetWithVisibilityResults" && isRecord(value.tweet)) return unwrapTweet(value.tweet);
  if (isRecord(value.result) && !looksLikeTweet(value, value)) return unwrapTweet(value.result);
  return value;
}

function looksLikeTweet(candidate: JsonRecord, legacy: JsonRecord): boolean {
  return Boolean(
    stringId(candidate.rest_id) || stringId(candidate.id_str) || stringId(legacy.id_str) ||
    firstString(legacy, ["full_text", "text"]) || firstString(candidate, ["full_text", "text"])
  );
}

function isOriginalTweet(candidate: JsonRecord, legacy: JsonRecord): boolean {
  return !(
    legacy.in_reply_to_status_id || legacy.in_reply_to_status_id_str || candidate.in_reply_to_status_id || candidate.in_reply_to_status_id_str ||
    isRecord(legacy.retweeted_status) || isRecord(candidate.retweeted_status) || isRecord(candidate.retweeted_status_result) ||
    (Array.isArray(candidate.referenced_tweets) && candidate.referenced_tweets.some((item) => isRecord(item) && (item.type === "retweeted" || item.type === "reposted")))
  );
}

function tweetUsername(value: JsonRecord): string | undefined {
  const direct = firstString(value, ["screen_name", "username"]);
  if (direct) return direct;
  for (const path of [
    ["user"], ["core", "user_results", "result"], ["user_results", "result"], ["author"], ["author_results", "result"]
  ]) {
    const user = recordAt(value, path);
    if (!user) continue;
    const legacy = isRecord(user.legacy) ? user.legacy : user;
    const username = firstString(legacy, ["screen_name", "username"]) || firstString(user, ["screen_name", "username"]);
    if (username) return username;
  }
  return undefined;
}

function externalUrlFromEntities(entities: JsonRecord): string | undefined {
  const urls = Array.isArray(entities.urls) ? entities.urls : [];
  for (const item of urls) {
    if (!isRecord(item)) continue;
    const url = firstString(item, ["unwound_url", "expanded_url", "url"]);
    if (url) return url;
  }
  return undefined;
}

function imageFromEntities(entities: JsonRecord): string | undefined {
  const media = Array.isArray(entities.media) ? entities.media : [];
  for (const item of media) {
    if (!isRecord(item)) continue;
    const url = firstString(item, ["media_url_https", "media_url", "url"]);
    if (url) return url;
  }
  return undefined;
}

function parseXPublishedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // X's embed payload uses a fixed RFC-822-like timestamp, for example
  // "Tue Aug 18 12:00:00 +0000 2026". It is safe to delegate this exact shape
  // to Date.parse; all other values use the reader's conservative parser.
  if (/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\s+20\d{2}$/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return parsePublishedAt(value);
}

function recordAt(value: JsonRecord, path: string[]): JsonRecord | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function firstString(value: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function stringId(value: unknown): string | undefined {
  if (typeof value === "string" && /^[0-9]{1,30}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
