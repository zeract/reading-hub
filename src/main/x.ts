import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { shell } from "electron";
import type { Account, ConnectorAdapter, RawEntry, Source, SyncContext, SyncResult } from "../shared/types";
import { compactText } from "../shared/text";
import { ReadingDatabase } from "./database";
import { builtInManifest } from "./connector-registry";
import { chromiumFetch } from "./network";
import { SecretStore } from "./secrets";
import { PublicHttpClient } from "./http";
import { parsePublicXTimeline, xPublicTimelineUrl } from "./x-public-timeline";

const REDIRECT_URI = "http://127.0.0.1:43119/x/callback";
const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_API_ROOT = "https://api.x.com/2";
const X_SCOPES = ["tweet.read", "users.read", "follows.read", "offline.access"];
const FOLLOW_REFRESH_MS = 6 * 60 * 60_000;
const DEFAULT_FOLLOW_LIMIT = 200;
// The public embed endpoint is shared by X's website widgets. Keep profile
// requests sparse even during an initial multi-source sync; a user can still
// refresh different non-X sources independently through the host scheduler.
const PUBLIC_EMBED_MIN_INTERVAL_MS = 3_000;

type XToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type XUser = { id: string; name: string; username: string };
type XPost = {
  id: string;
  text?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  entities?: { urls?: Array<{ expanded_url?: string; unwound_url?: string; url?: string }> };
};

type XResponse<T> = { data?: T; meta?: { next_token?: string; result_count?: number } };
type XFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class XApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "XApiError";
  }
}

/**
 * X supports two deliberately separated paths: official OAuth for a reader's
 * following list, and X's public embed timeline for one public profile. Both
 * paths avoid browser cookies and private web API calls.
 */
export class XConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("x", "X", ["oauth", "public-http"], ["api.x.com", "x.com", "syndication.twitter.com"]);
  private publicEmbedNextRequestAt = 0;

  constructor(
    private readonly database: ReadingDatabase,
    private readonly secrets: SecretStore,
    private readonly openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url),
    // Keep X on Electron's Chromium network stack. It honours the system
    // proxy/VPN configuration, unlike Node's built-in fetch on macOS.
    private readonly fetchX: XFetch = chromiumFetch,
    private readonly publicHttp: Pick<PublicHttpClient, "getText"> = new PublicHttpClient()
  ) {}

  /**
   * X requires the user to create an approved developer App. Only its public
   * client ID is entered here; access/refresh tokens stay in Keychain.
   */
  async authorizeWithClientId(clientId: string): Promise<Account> {
    const safeClientId = clientId.trim();
    if (!safeClientId) throw new Error("请先填写 X Developer App 的 Client ID。");
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const authorizationUrl = new URL(X_AUTHORIZE_URL);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: safeClientId,
      redirect_uri: REDIRECT_URI,
      scope: X_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    }).toString();

    const code = await this.waitForAuthorizationCode(authorizationUrl.toString(), state);
    const token = await this.exchangeAuthorizationCode(safeClientId, code, verifier);
    const user = await this.requestJson<XResponse<XUser>>("/users/me", token.accessToken).then((response) => response.data);
    if (!user?.id) throw new Error("X 授权成功，但未返回账号身份。");

    // This lightweight request verifies the permission that makes the
    // following-feed connector possible before a source is created.
    await this.requestJson<XResponse<XUser[]>>(`/users/${encodeURIComponent(user.id)}/following?max_results=5`, token.accessToken);

    const existing = this.database.findAccount("x", user.id);
    const accountId = existing?.id ?? randomUUID();
    const keychainAccount = await this.secrets.setConnectorSecret("x", accountId, JSON.stringify(token));
    return this.database.saveAccount({
      id: accountId,
      connectorId: "x",
      displayName: `X · @${user.username || user.name}`,
      subjectId: user.id,
      keychainAccount,
      scopes: X_SCOPES,
      status: "active",
      config: { clientId: safeClientId, username: user.username }
    });
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    const profileUsername = stringValue(context.subscription.config.username);
    if (context.subscription.config.mode === "public-profile") {
      if (!profileUsername) throw new Error("X 公开博主来源缺少用户名，请删除后重新添加。");
      return this.syncPublicProfile(profileUsername, context.source);
    }
    const account = context.account;
    if (!account?.subjectId) throw new Error("X 来源缺少有效的授权账号，请重新连接 X。");
    try {
      const token = await this.tokenFor(account);
      if (context.subscription.config.mode === "profile") {
        if (!profileUsername) throw new Error("X 博主来源缺少用户名，请删除后重新添加。");
        return this.syncProfile(profileUsername, token.accessToken, context.checkpoint);
      }
      return this.syncFollowing(account.subjectId, token.accessToken, context.subscription.config, context.checkpoint);
    } catch (error) {
      // A 403 can mean a protected target or a product entitlement issue; it
      // does not prove the local OAuth token has expired. Only X's 401 is a
      // safe reason to invalidate the saved account.
      if (error instanceof XApiError && error.status === 401) this.database.updateAccountStatus(account.id, "expired");
      throw error;
    }
  }

  private async syncPublicProfile(username: string, source: Source): Promise<SyncResult> {
    let response;
    try {
      await this.waitForPublicEmbedSlot();
      response = await this.publicHttp.getText(xPublicTimelineUrl(username), {
        etag: source.etag,
        lastModified: source.lastModified
      });
    } catch (error) {
      throw publicTimelineError(error);
    }
    if (response.status === 304) return { entries: [], notModified: true, emptyIsHealthy: true };
    const timeline = parsePublicXTimeline(response.text, username);
    if (!timeline.recognized) {
      throw new Error("X 未在公开嵌入时间线中返回可解析的帖子数据。该博主可能受保护、页面结构已变化或暂不可公开订阅；Reading Hub 不会使用 Cookie、登录态或私有 X Web API 绕过限制。");
    }
    const newest = latestId(timeline.entries.flatMap((entry) => entry.externalId ? [entry.externalId] : []));
    return {
      entries: timeline.entries,
      emptyIsHealthy: true,
      etag: response.etag,
      lastModified: response.lastModified,
      checkpoint: { sinceId: newest, data: { username, transport: "x-public-embed" } }
    };
  }

  private async waitForPublicEmbedSlot(): Promise<void> {
    const now = Date.now();
    const requestedAt = Math.max(now, this.publicEmbedNextRequestAt);
    this.publicEmbedNextRequestAt = requestedAt + PUBLIC_EMBED_MIN_INTERVAL_MS;
    const delay = requestedAt - now;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private async syncFollowing(
    accountUserId: string,
    accessToken: string,
    config: Record<string, unknown>,
    checkpoint: SyncContext["checkpoint"]
  ): Promise<SyncResult> {
    const checkpointData = checkpoint?.data ?? {};
    const now = Date.now();
    let followed = decodeFollowed(checkpointData.followed);
    const refreshedAt = numberValue(checkpointData.followingRefreshedAt);
    if (!followed.length || !refreshedAt || now - refreshedAt >= FOLLOW_REFRESH_MS) {
      followed = await this.fetchFollowing(accountUserId, accessToken);
    }
    const configuredLimit = numberValue(config.maxFollowees);
    const limit = Math.max(1, Math.min(configuredLimit || DEFAULT_FOLLOW_LIMIT, DEFAULT_FOLLOW_LIMIT));
    const tracked = followed.slice(0, limit);
    const sinceByUser = objectValue(checkpointData.sinceByUser);
    const nextSinceByUser: Record<string, string> = { ...stringRecord(sinceByUser) };
    const entries: RawEntry[] = [];
    for (const user of tracked) {
      const fetched = await this.fetchUserPosts(user, accessToken, nextSinceByUser[user.id]);
      if (fetched.sinceId) nextSinceByUser[user.id] = fetched.sinceId;
      entries.push(...fetched.entries);
    }
    return {
      entries,
      emptyIsHealthy: true,
      checkpoint: {
        sinceId: latestId(Object.values(nextSinceByUser)),
        data: { followed, followingRefreshedAt: now, sinceByUser: nextSinceByUser }
      }
    };
  }

  private async syncProfile(username: string, accessToken: string, checkpoint: SyncContext["checkpoint"]): Promise<SyncResult> {
    const profile = await this.requestJson<XResponse<XUser>>(
      `/users/by/username/${encodeURIComponent(username)}?user.fields=name,username`,
      accessToken
    ).then((response) => response.data);
    if (!profile?.id || !profile.username) throw new Error("未找到该 X 博主，或该主页目前不可公开读取。");
    const fetched = await this.fetchUserPosts(profile, accessToken, checkpoint?.sinceId);
    return {
      entries: fetched.entries,
      emptyIsHealthy: true,
      checkpoint: {
        sinceId: fetched.sinceId,
        data: { username: profile.username, userId: profile.id }
      }
    };
  }

  private async fetchUserPosts(user: XUser, accessToken: string, sinceId?: string): Promise<{ entries: RawEntry[]; sinceId?: string }> {
    const query = new URLSearchParams({
      max_results: "20",
      exclude: "replies,retweets",
      "tweet.fields": "created_at,entities,referenced_tweets,in_reply_to_user_id"
    });
    if (sinceId) query.set("since_id", sinceId);
    const response = await this.requestJson<XResponse<XPost[]>>(
      `/users/${encodeURIComponent(user.id)}/tweets?${query}`,
      accessToken
    );
    let nextSinceId = sinceId;
    const entries: RawEntry[] = [];
    for (const post of response.data ?? []) {
      // Advance across filtered replies/reposts too, otherwise a busy author
      // can keep an unwanted page at the front of every poll.
      if (!nextSinceId || isNewerId(post.id, nextSinceId)) nextSinceId = post.id;
      if (!isOriginalPost(post)) continue;
      const raw = postToEntry(post, user);
      if (raw) entries.push(raw);
    }
    return { entries, sinceId: nextSinceId };
  }

  normalize(item: RawEntry, source: Source) {
    const now = Date.now();
    const identity = item.canonicalIdentity || `x:${item.externalId || item.url}`;
    return {
      id: randomUUID(),
      sourceId: source.id,
      canonicalUrl: item.url,
      canonicalIdentity: identity,
      url: item.url,
      title: item.title,
      author: item.author,
      publishedAt: item.publishedAt,
      summary: item.summary,
      imageUrl: item.imageUrl,
      contentHash: createHash("sha256").update(`${identity}\n${item.title}\n${item.summary || ""}`).digest("hex"),
      read: false,
      favorite: false,
      createdAt: now,
      observedAt: item.observedAt ?? now,
      providerId: "x" as const,
      providerLabel: "X",
      externalId: item.externalId
    };
  }

  private async fetchFollowing(userId: string, accessToken: string): Promise<XUser[]> {
    const users: XUser[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ max_results: "1000", "user.fields": "name,username" });
      if (cursor) query.set("pagination_token", cursor);
      const response = await this.requestJson<XResponse<XUser[]>>(`/users/${encodeURIComponent(userId)}/following?${query}`, accessToken);
      users.push(...(response.data ?? []).filter((item) => item.id && item.username));
      cursor = response.meta?.next_token;
    } while (cursor && users.length < DEFAULT_FOLLOW_LIMIT);
    return users.slice(0, DEFAULT_FOLLOW_LIMIT);
  }

  private async tokenFor(account: Account): Promise<XToken> {
    const raw = await this.secrets.getConnectorSecret(account.keychainAccount);
    if (!raw) {
      this.database.updateAccountStatus(account.id, "expired");
      throw new Error("X 授权已失效，请重新连接 X。");
    }
    let token: XToken;
    try {
      token = JSON.parse(raw) as XToken;
    } catch {
      this.database.updateAccountStatus(account.id, "error");
      throw new Error("X 本地授权信息无法读取，请重新连接 X。");
    }
    if (!token.accessToken) throw new Error("X 授权信息不完整，请重新连接 X。");
    if (!token.expiresAt || token.expiresAt > Date.now() + 60_000) return token;
    const clientId = stringValue(account.config?.clientId);
    if (!clientId || !token.refreshToken) {
      this.database.updateAccountStatus(account.id, "expired");
      throw new Error("X 授权已到期，请重新连接 X。");
    }
    try {
      const refreshed = await this.refreshToken(clientId, token.refreshToken);
      const keychainAccount = await this.secrets.setConnectorSecret("x", account.id, JSON.stringify(refreshed));
      this.database.saveAccount({ ...account, keychainAccount, status: "active" });
      return refreshed;
    } catch (error) {
      this.database.updateAccountStatus(account.id, "expired");
      throw error;
    }
  }

  private async waitForAuthorizationCode(url: string, expectedState: string): Promise<string> {
    const code = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const server = createServer((request, response) => {
        const callback = new URL(request.url || "/", REDIRECT_URI);
        if (callback.pathname !== "/x/callback") {
          response.writeHead(404).end();
          return;
        }
        const providerError = callback.searchParams.get("error");
        const state = callback.searchParams.get("state");
        const receivedCode = callback.searchParams.get("code");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<p>Reading Hub 已收到 X 授权。你可以关闭此页面并回到应用。</p>");
        finish(() => {
          server.close();
          if (state !== expectedState) reject(new Error("X 授权状态校验失败，请重试。"));
          else if (providerError) reject(new Error(`X 授权被取消或拒绝：${providerError}`));
          else if (!receivedCode) reject(new Error("X 未返回授权码，请重试。"));
          else resolve(receivedCode);
        });
      });
      server.once("error", (error) => finish(() => reject(new Error(`无法启动 X 授权回调：${error.message}`))));
      server.listen(43119, "127.0.0.1", () => {
        void this.openExternal(url).catch((error) => finish(() => {
          server.close();
          reject(error instanceof Error ? error : new Error("无法打开 X 授权页面。"));
        }));
      });
      const timeout = setTimeout(() => finish(() => {
        server.close();
        reject(new Error("等待 X 授权超时，请重试。"));
      }), 5 * 60_000);
      server.once("close", () => clearTimeout(timeout));
    });
    return code;
  }

  private async exchangeAuthorizationCode(clientId: string, code: string, verifier: string): Promise<XToken> {
    return this.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT_URI, code_verifier: verifier
    }));
  }

  private async refreshToken(clientId: string, refreshToken: string): Promise<XToken> {
    return this.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }));
  }

  private async exchangeToken(body: URLSearchParams): Promise<XToken> {
    let response: Response;
    try {
      response = await this.fetchX(X_TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      // Do not expose a network exception: it can contain request metadata
      // including OAuth parameters. The caller only needs a useful next step.
      throw new XApiError("无法连接到 X OAuth 令牌服务。请检查系统代理、VPN、DNS 或网络访问后重试。");
    }
    const payload = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !payload.access_token) {
      throw new XApiError(
        response.status === 400
          ? "X OAuth 配置或授权码无效。请确认已启用 OAuth 2.0、回调地址完全匹配，然后重新授权。"
          : `X OAuth 令牌交换失败（HTTP ${response.status}）。请检查应用权限和 X Developer 账户状态。`,
        response.status
      );
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined
    };
  }

  private async requestJson<T>(path: string, accessToken: string): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), `${X_API_ROOT}/`);
    if (url.protocol !== "https:" || url.hostname !== "api.x.com") throw new Error("X 连接器拒绝访问未授权域名。");
    let response: Response;
    try {
      response = await this.fetchX(url.toString(), {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw new XApiError("无法连接到 X API。请检查系统代理、VPN、DNS 或网络访问后重试。");
    }
    const payload = await response.json().catch(() => ({})) as T;
    if (!response.ok) throw new XApiError(xHttpFailureMessage(response.status, path), response.status);
    return payload;
  }
}

function postToEntry(post: XPost, author: XUser): RawEntry | undefined {
  const text = compactText(post.text, 2_000);
  if (!post.id || !text) return undefined;
  const externalUrl = post.entities?.urls?.map((item) => item.unwound_url || item.expanded_url || item.url).find(Boolean);
  const url = `https://x.com/${encodeURIComponent(author.username)}/status/${encodeURIComponent(post.id)}`;
  return {
    url,
    title: compactText(text.replace(/\s+/g, " "), 150) || "X 帖子",
    summary: text,
    author: `@${author.username}`,
    publishedAt: post.created_at ? Date.parse(post.created_at) || undefined : undefined,
    externalId: post.id,
    canonicalIdentity: `x:${post.id}`,
    externalUrl,
    observedAt: Date.now(),
    providerId: "x",
    providerLabel: "X"
  };
}

function isOriginalPost(post: XPost): boolean {
  return !post.in_reply_to_user_id && !(post.referenced_tweets || []).some((item) => item.type === "retweeted" || item.type === "reposted");
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function decodeFollowed(value: unknown): XUser[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is XUser => Boolean(item) && typeof item === "object" && typeof (item as XUser).id === "string" && typeof (item as XUser).username === "string");
}

function isNewerId(left: string, right: string): boolean {
  try { return BigInt(left) > BigInt(right); } catch { return left > right; }
}

function latestId(ids: string[]): string | undefined {
  return ids.filter(Boolean).reduce<string | undefined>((latest, id) => !latest || isNewerId(id, latest) ? id : latest, undefined);
}

function xHttpFailureMessage(status: number, path: string): string {
  const operation = path.startsWith("/users/me")
    ? "读取当前 X 账号"
    : path.includes("/by/username/")
      ? "读取 X 博主主页"
    : path.includes("/following")
      ? "读取 X 关注列表"
      : path.includes("/tweets")
        ? "读取关注者动态"
        : "调用 X API";
  if (status === 402) {
    return `${operation}需要 X API 的可用计费访问（HTTP 402）。请在 X Developer Console 的 Billing / Usage 中为该项目启用 API 额度后重新连接。`;
  }
  return `X API 请求失败（HTTP ${status}）。请检查开发者权限、额度和授权范围。`;
}

function publicTimelineError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (/HTTP 429/.test(message)) {
    return new Error("X 公开嵌入时间线暂时限流（HTTP 429）。Reading Hub 会按来源刷新间隔和同域串行策略重试；请不要频繁手动刷新。");
  }
  if (/HTTP 404|HTTP 403/.test(message)) {
    return new Error("该 X 主页不可通过公开嵌入时间线读取。它可能受保护、已不存在或暂时限制公开嵌入；Reading Hub 不会使用 Cookie、登录态或私有 Web API 绕过限制。");
  }
  return error instanceof Error ? error : new Error("无法读取 X 公开嵌入时间线。");
}
