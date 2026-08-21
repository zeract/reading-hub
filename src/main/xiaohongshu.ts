import { randomUUID } from "node:crypto";
import { compactText, parsePublishedAt } from "../shared/text";
import { canonicalizeUrl, toAbsoluteUrl } from "../shared/url";
import { contentHash } from "./content-hash";
import type { ConnectorAdapter, RawEntry, Source, SyncContext, SyncResult } from "../shared/types";
import { builtInManifest } from "./connector-registry";
import { PublicHttpClient } from "./http";

type JsonRecord = Record<string, unknown>;

/**
 * Reads only the structured data already present on a public profile response.
 * It deliberately has no cookie, credential, private API, guest-token, or
 * CAPTCHA path; a profile that requires those mechanisms is reported as not
 * subscribable instead of being silently treated as an empty source.
 */
export class XiaohongshuConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest(
    "xiaohongshu",
    "小红书公开博主",
    ["public-http"],
    ["xiaohongshu.com", "www.xiaohongshu.com"]
  );

  constructor(private readonly http: PublicHttpClient) {}

  async sync(context: SyncContext): Promise<SyncResult> {
    const response = await this.http.getText(context.source.url, {
      etag: context.source.etag,
      lastModified: context.source.lastModified
    });
    if (response.status === 304) return { entries: [], notModified: true, emptyIsHealthy: true };
    const entries = extractPublicXiaohongshuNotes(response.text, response.url);
    if (!entries.length) {
      throw new Error("小红书未在未登录的公开页面中提供可读取的笔记列表。Reading Hub 不会使用 Cookie、登录态或反爬绕过；可改为粘贴单篇分享链接保存。");
    }
    return {
      entries,
      emptyIsHealthy: true,
      etag: response.etag,
      lastModified: response.lastModified,
      checkpoint: { data: { lastPublicProfileCheckAt: Date.now() } }
    };
  }

  normalize(item: RawEntry, source: Source) {
    const canonicalUrl = canonicalizeUrl(item.url);
    const now = Date.now();
    return {
      ...item,
      id: randomUUID(),
      sourceId: source.id,
      canonicalUrl,
      canonicalIdentity: item.canonicalIdentity ?? canonicalUrl,
      contentHash: contentHash(item),
      read: false,
      favorite: false,
      createdAt: now,
      observedAt: item.observedAt ?? now,
      providerId: "xiaohongshu" as const,
      providerLabel: "小红书"
    };
  }
}

/** Exported for deterministic fixtures; it never executes page JavaScript. */
export function extractPublicXiaohongshuNotes(html: string, pageUrl: string): RawEntry[] {
  const values = extractJsonValues(html);
  const entries: RawEntry[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    visitJson(value, (item) => {
      const note = noteFromRecord(item, pageUrl);
      if (!note || seen.has(note.url)) return;
      seen.add(note.url);
      entries.push(note);
    });
  }
  return entries.slice(0, 100);
}

function extractJsonValues(html: string): unknown[] {
  const values: unknown[] = [];
  const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const text = script[1].trim();
    const value = parseStructuredScript(text);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function parseStructuredScript(text: string): unknown | undefined {
  if (!text) return undefined;
  if (text[0] === "{" || text[0] === "[") return parseJson(text);
  // Several public page variants expose their hydration payload through this
  // assignment. We extract its balanced JSON literal as text only; no remote
  // JavaScript is evaluated in the main process or renderer.
  const assignment = text.match(/^(?:window\.)?__(?:INITIAL_STATE|SSR_DATA|INITIAL_PROPS)__\s*=\s*/);
  if (!assignment) return undefined;
  const start = assignment[0].length;
  const payload = balancedJsonLiteral(text, start);
  return payload ? parseJson(payload) : undefined;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function balancedJsonLiteral(value: string, start: number): string | undefined {
  const opening = value[start];
  if (opening !== "{" && opening !== "[") return undefined;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) return value.slice(start, index + 1);
  }
  return undefined;
}

function visitJson(value: unknown, onRecord: (record: JsonRecord) => void): void {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length && visited < 40_000) {
    const current = stack.pop();
    visited += 1;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }
    if (!isRecord(current)) continue;
    onRecord(current);
    const children = Object.values(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child && typeof child === "object") stack.push(child);
    }
  }
}

function noteFromRecord(value: JsonRecord, pageUrl: string): RawEntry | undefined {
  const card = isRecord(value.noteCard) ? value.noteCard : value;
  const noteId = firstString(value, ["noteId", "note_id", "noteID"]) || firstString(card, ["noteId", "note_id", "noteID"]);
  if (!noteId || !/^[A-Za-z0-9_-]{8,160}$/.test(noteId)) return undefined;
  const title = compactText(firstString(card, ["title", "displayTitle", "name"]) || firstString(card, ["desc", "description", "content"]), 240);
  const author = authorName(card);
  const imageUrl = imageFromRecord(card, pageUrl);
  // A matching ID alone is not enough: profiles and unrelated metadata can
  // contain it. Require readable content and at least one card characteristic.
  if (!title || (!author && !imageUrl && !hasAny(card, ["likedCount", "interactInfo", "createTime", "time", "type"]))) return undefined;
  const publishedAt = timeFromRecord(card);
  const url = `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;
  return {
    url,
    title,
    author,
    publishedAt,
    summary: compactText(firstString(card, ["desc", "description", "content"]), 500),
    imageUrl,
    externalId: noteId,
    canonicalIdentity: `xiaohongshu:${noteId}`,
    observedAt: Date.now(),
    providerId: "xiaohongshu",
    providerLabel: "小红书"
  };
}

function authorName(value: JsonRecord): string | undefined {
  for (const candidate of [value.user, value.userInfo, value.author]) {
    if (!isRecord(candidate)) continue;
    const name = compactText(firstString(candidate, ["nickname", "nickName", "name", "userName"]), 120);
    if (name) return name;
  }
  return undefined;
}

function imageFromRecord(value: JsonRecord, pageUrl: string): string | undefined {
  const candidates: unknown[] = [value.cover, value.coverUrl, value.image, value.imageList, value.images];
  for (const candidate of candidates) {
    const image = findImage(candidate);
    if (image) return toAbsoluteUrl(image, pageUrl);
  }
  return undefined;
}

function findImage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findImage(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  return firstString(value, ["urlDefault", "urlPre", "url", "src", "originUrl", "original"]);
}

function timeFromRecord(value: JsonRecord): number | undefined {
  const raw = value.createTime ?? value.create_time ?? value.publishTime ?? value.time ?? value.publish_time;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1_000 : raw;
  if (typeof raw === "string") return parsePublishedAt(raw);
  return undefined;
}

function firstString(value: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function hasAny(value: JsonRecord, keys: string[]): boolean {
  return keys.some((key) => value[key] !== undefined && value[key] !== null);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
