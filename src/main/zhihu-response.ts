import type { Followee, RawEntry } from "../shared/types";
import { compactText } from "../shared/text";
import { assertPublicUrl } from "../shared/url";

type RecordValue = Record<string, unknown>;
export class ZhihuResponseError extends Error {
  constructor() { super("知乎接口响应无效，请稍后重试。"); this.name = "ZhihuResponseError"; }
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ZhihuResponseError();
  return value as RecordValue;
}

function text(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ZhihuResponseError();
  return compactText(value, max);
}

function url(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ZhihuResponseError();
  try { return assertPublicUrl(value).toString(); }
  catch { throw new ZhihuResponseError(); }
}

function items(value: unknown): RecordValue[] {
  const list = record(value).Items;
  if (!Array.isArray(list)) throw new ZhihuResponseError();
  return list.map(record);
}

export function readZhihuEnvelope(value: unknown): { code: number; data: unknown } {
  const body = record(value);
  if (!Number.isSafeInteger(body.Code)) throw new ZhihuResponseError();
  return { code: body.Code as number, data: body.Data };
}

export function readZhihuEntries(value: unknown): RawEntry[] {
  return items(value).flatMap((item) => {
    // Preserve the existing omission of explicit items without a content URL.
    if (item.Url === undefined || item.Url === null || item.Url === "") return [];
    const author = item.Author === undefined || item.Author === null ? undefined : record(item.Author);
    const seconds = item.CreatedAt;
    if (seconds !== undefined && seconds !== null && (typeof seconds !== "number" || !Number.isFinite(seconds) || Math.abs(seconds * 1000) > 8.64e15)) throw new ZhihuResponseError();
    return [{
      url: url(item.Url), title: text(item.Title, 240) || "知乎内容",
      summary: text(item.Summary, 500), author: text(author?.Name, 120),
      publishedAt: typeof seconds === "number" ? seconds * 1000 : undefined
    }];
  });
}

export function readZhihuFolloweePage(value: unknown): { entries: Followee[]; next?: string } {
  const entries = items(value).map((item): Followee => {
    const token = typeof item.UrlToken === "string" ? item.UrlToken : Number.isSafeInteger(item.UrlToken) ? String(item.UrlToken) : "";
    if (!token.trim() || token.length > 200) throw new ZhihuResponseError();
    const count = item.FollowerCount;
    if (count !== undefined && count !== null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new ZhihuResponseError();
    return {
      urlToken: token, fullname: text(item.Fullname, 120) || "知乎用户", url: url(item.Url),
      avatarUrl: item.AvatarUrl === undefined || item.AvatarUrl === null || item.AvatarUrl === "" ? undefined : url(item.AvatarUrl),
      headline: text(item.Headline, 240), followerCount: typeof count === "number" ? count : undefined,
      updatedAt: Date.now()
    };
  });
  const paging = record(value).Paging;
  if (paging === undefined || paging === null) return { entries };
  const page = record(paging);
  if (page.IsEnd !== undefined && typeof page.IsEnd !== "boolean") throw new ZhihuResponseError();
  if (page.IsEnd === true) return { entries };
  if (page.NextOffset === undefined || page.NextOffset === null || page.NextOffset === "") {
    if (page.IsEnd === false) throw new ZhihuResponseError();
    return { entries };
  }
  if (typeof page.NextOffset !== "string" || page.NextOffset.length > 2000) throw new ZhihuResponseError();
  return { entries, next: page.NextOffset };
}
