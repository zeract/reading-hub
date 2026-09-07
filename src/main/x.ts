import { ApiRequestBoundaryError } from "./api-response";
import { abortError, throwIfAborted } from "./cancellation";
import { InvalidJsonResponseError, requestJsonWithTimeout } from "./json-response";
import { KeyedTaskQueue } from "./keyed-task-queue";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { shell } from "electron";
import type { Account, ConnectorAdapter, RawEntry, Source, SyncContext, SyncResult } from "../shared/types";
import { compactText } from "../shared/text";
import type { ReadingDatabase } from "./database";
import { builtInManifest } from "./connector-registry";
import { contentNormalizer } from "./content-normalizer";
import { chromiumFetch } from "./network";
import type { SecretStore } from "./secrets";

const REDIRECT_URI = "http://127.0.0.1:43119/x/callback";
const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_API_ROOT = "https://api.x.com/2";
const X_SCOPES = ["tweet.read", "users.read", "follows.read", "offline.access"];
const FOLLOW_REFRESH_MS = 6 * 60 * 60_000;
const DEFAULT_FOLLOW_LIMIT = 200;

type XToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type XUser = { id: string; name?: string; username: string };
type XPostPage = { cursor: string; highWaterId: string };
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
 * X synchronization uses its documented OAuth API. The host owns the OAuth
 * callback and keeps tokens in Keychain; this connector never reuses browser
 * cookies or calls private web endpoints.
 */
export class XConnector implements ConnectorAdapter {
  readonly manifest = builtInManifest("x", "X", ["oauth"], ["api.x.com", "x.com"]);
  private readonly credentials = new KeyedTaskQueue();

  constructor(
    private readonly database: Pick<ReadingDatabase, "getAccount" | "findAccount" | "saveAccount" | "updateAccountStatus">,
    private readonly secrets: Pick<SecretStore, "getConnectorSecret" | "setConnectorSecret">,
    private readonly openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url),
    // Keep X on Electron's Chromium network stack. It honours the system
    // proxy/VPN configuration, unlike Node's built-in fetch on macOS.
    private readonly fetchX: XFetch = chromiumFetch
  ) {}

  /**
   * X requires the user to create an approved developer App. Only its public
   * client ID is entered here; access/refresh tokens stay in Keychain.
   */
  async authorizeWithClientId(clientId: string, signal?: AbortSignal): Promise<Account> {
    throwIfAborted(signal);
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

    const code = await this.waitForAuthorizationCode(authorizationUrl.toString(), state, signal);
    const token = await this.exchangeAuthorizationCode(safeClientId, code, verifier, signal);
    const user = await this.requestJson<XResponse<XUser>>("/users/me", token.accessToken, signal).then((response) => response.data);
    if (!isXUser(user)) throw new Error("X 授权成功，但未返回有效账号身份。");

    // This lightweight request verifies the permission that makes the
    // following-feed connector possible before a source is created.
    readXPage(await this.requestJson<XResponse<XUser[]>>(`/users/${encodeURIComponent(user.id)}/following?max_results=5`, token.accessToken, signal), isXUser);

    return this.credentials.run(user.id, async () => {
      throwIfAborted(signal);
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
    }, signal);
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    const profileUsername = stringValue(context.subscription.config.username);
    const account = context.account;
    if (!account?.subjectId) throw new Error("X 来源缺少有效的授权账号，请重新连接 X。");
    let token: XToken | undefined;
    try {
      token = await this.credentials.run(account.subjectId, () => this.tokenFor(account.id, context.signal), context.signal);
      throwIfAborted(context.signal);
      if (context.subscription.config.mode === "profile") {
        if (!profileUsername) throw new Error("X 博主来源缺少用户名，请删除后重新添加。");
        return await this.syncProfile(profileUsername, token.accessToken, context.checkpoint, context.signal);
      }
      return await this.syncFollowing(account.subjectId, token.accessToken, context.subscription.config, context.checkpoint, context.signal);
    } catch (error) {
      throwIfAborted(context.signal);
      // A 403 can mean a protected target or a product entitlement issue; it
      // does not prove the local OAuth token has expired. Only X's 401 is a
      // safe reason to invalidate the saved account.
      if (token && error instanceof XApiError && error.status === 401) {
        const rejectedToken = token.accessToken;
        await this.credentials.run(account.subjectId, async () => {
          const current = this.database.getAccount(account.id);
          if (!current) return;
          const raw = await this.secrets.getConnectorSecret(current.keychainAccount);
          throwIfAborted(context.signal);
          // A response using old credentials cannot invalidate a later refresh
          // or a newly authorized session. The comparison stays in memory.
          let accessToken: unknown;
          try { accessToken = raw ? JSON.parse(raw)?.accessToken : undefined; } catch { return; }
          if (accessToken === rejectedToken) this.database.updateAccountStatus(account.id, "expired");
        }, context.signal);
      }
      throw error;
    }
  }

  private async syncFollowing(
    accountUserId: string,
    accessToken: string,
    config: Record<string, unknown>,
    checkpoint: SyncContext["checkpoint"],
    signal?: AbortSignal
  ): Promise<SyncResult> {
    const checkpointData = checkpoint?.data ?? {};
    const now = Date.now();
    let followed = decodeFollowed(checkpointData.followed);
    let refreshedAt = numberValue(checkpointData.followingRefreshedAt);
    if (!Array.isArray(checkpointData.followed) || !refreshedAt || refreshedAt > now || now - refreshedAt >= FOLLOW_REFRESH_MS) {
      followed = await this.fetchFollowing(accountUserId, accessToken, signal);
      refreshedAt = now;
    }
    const configuredLimit = numberValue(config.maxFollowees);
    const limit = Math.max(1, Math.min(configuredLimit || DEFAULT_FOLLOW_LIMIT, DEFAULT_FOLLOW_LIMIT));
    const tracked = followed.slice(0, limit);
    const sinceByUser = objectValue(checkpointData.sinceByUser);
    const nextSinceByUser: Record<string, string> = { ...stringRecord(sinceByUser) };
    const pendingByUser = objectValue(checkpointData.pendingByUser);
    const nextPendingByUser: Record<string, XPostPage> = {};
    const entries: RawEntry[] = [];
    for (const user of tracked) {
      const fetched = await this.fetchUserPosts(user, accessToken, nextSinceByUser[user.id], decodePostPage(pendingByUser[user.id]), signal);
      if (fetched.sinceId) nextSinceByUser[user.id] = fetched.sinceId;
      if (fetched.pending) nextPendingByUser[user.id] = fetched.pending;
      entries.push(...fetched.entries);
    }
    return {
      entries,
      emptyIsHealthy: true,
      checkpoint: {
        sinceId: latestId(Object.values(nextSinceByUser)),
        data: { followed, followingRefreshedAt: refreshedAt, sinceByUser: nextSinceByUser, pendingByUser: nextPendingByUser }
      }
    };
  }

  private async syncProfile(username: string, accessToken: string, checkpoint: SyncContext["checkpoint"], signal?: AbortSignal): Promise<SyncResult> {
    const profile = await this.requestJson<XResponse<XUser>>(
      `/users/by/username/${encodeURIComponent(username)}?user.fields=name,username`,
      accessToken, signal
    ).then((response) => response.data);
    if (!isXUser(profile)) throw new Error("未找到该 X 博主，或该主页目前不可公开读取。");
    const fetched = await this.fetchUserPosts(profile, accessToken, checkpoint?.sinceId, decodePostPage(checkpoint?.data?.pendingPosts), signal);
    return {
      entries: fetched.entries,
      emptyIsHealthy: true,
      checkpoint: {
        sinceId: fetched.sinceId,
        data: { username: profile.username, userId: profile.id, pendingPosts: fetched.pending }
      }
    };
  }

  private async fetchUserPosts(user: XUser, accessToken: string, sinceId?: string, pending?: XPostPage, signal?: AbortSignal): Promise<{ entries: RawEntry[]; sinceId?: string; pending?: XPostPage }> {
    const query = new URLSearchParams({
      max_results: "20",
      exclude: "replies,retweets",
      "tweet.fields": "created_at,entities,referenced_tweets,in_reply_to_user_id"
    });
    if (sinceId) query.set("since_id", sinceId);
    // Initial collection retains the existing latest-page scope. Incremental
    // runs keep their committed lower bound until the entire gap is consumed.
    if (!sinceId) pending = undefined;
    if (pending) query.set("pagination_token", pending.cursor);
    const request = () => this.requestJson<XResponse<XPost[]>>(`/users/${encodeURIComponent(user.id)}/tweets?${query}`, accessToken, signal);
    let response: XResponse<XPost[]>;
    try { response = await request(); }
    catch (error) {
      throwIfAborted(signal);
      if (!pending || !(error instanceof XApiError) || error.status !== 400) throw error;
      // A saved pagination token may expire. Restart from the unchanged lower
      // bound; database deduplication makes replay safe without skipping posts.
      query.delete("pagination_token");
      pending = undefined;
      response = await request();
    }
    let nextSinceId = latestId([sinceId ?? "", pending?.highWaterId ?? ""]);
    const entries: RawEntry[] = [];
    const page = readXPage(response, isXPost);
    for (const post of page.items) {
      // Advance across filtered replies/reposts too, otherwise a busy author
      // can keep an unwanted page at the front of every poll.
      if (!nextSinceId || isNewerId(post.id, nextSinceId)) nextSinceId = post.id;
      if (!isOriginalPost(post)) continue;
      const raw = postToEntry(post, user);
      if (raw) entries.push(raw);
    }
    const cursor = page.cursor;
    if (sinceId && cursor) {
      if (cursor === pending?.cursor) throw new Error("X 帖子分页未前进，已保留同步进度，请稍后重试。");
      return { entries, sinceId, pending: { cursor, highWaterId: nextSinceId ?? sinceId } };
    }
    return { entries, sinceId: nextSinceId };
  }

  normalize(item: RawEntry, source: Source) {
    return contentNormalizer.normalize(item, source, X_CONTENT_NORMALIZATION);
  }

  private async fetchFollowing(userId: string, accessToken: string, signal?: AbortSignal): Promise<XUser[]> {
    const users = new Map<string, XUser>();
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ max_results: "1000", "user.fields": "name,username" });
      if (cursor) query.set("pagination_token", cursor);
      const response = await this.requestJson<XResponse<XUser[]>>(`/users/${encodeURIComponent(userId)}/following?${query}`, accessToken, signal);
      const page = readXPage(response, isXUser);
      for (const user of page.items) users.set(user.id, user);
      cursor = page.cursor;
      if (cursor && users.size < DEFAULT_FOLLOW_LIMIT) {
        if (visited.has(cursor) || visited.size >= DEFAULT_FOLLOW_LIMIT) throw new Error("X 关注列表分页未完成，已保留原有列表，请稍后重试。");
        visited.add(cursor);
      }
    } while (cursor && users.size < DEFAULT_FOLLOW_LIMIT);
    return [...users.values()].slice(0, DEFAULT_FOLLOW_LIMIT);
  }

  /** Must be called while holding the account's credential turn. */
  private async tokenFor(accountId: string, signal?: AbortSignal): Promise<XToken> {
    const account = this.database.getAccount(accountId);
    if (!account) throw new Error("X 授权账号不存在，请重新连接 X。");
    const raw = await this.secrets.getConnectorSecret(account.keychainAccount);
    throwIfAborted(signal);
    if (!raw) {
      this.database.updateAccountStatus(account.id, "expired");
      throw new Error("X 授权已失效，请重新连接 X。");
    }
    let token: XToken;
    try {
      const decoded = decodeXToken(JSON.parse(raw));
      if (!decoded) throw new Error("Invalid stored token");
      token = decoded;
    } catch {
      this.database.updateAccountStatus(account.id, "error");
      throw new Error("X 本地授权信息无法读取，请重新连接 X。");
    }
    if (token.expiresAt === undefined || token.expiresAt > Date.now() + 60_000) return token;
    const clientId = stringValue(account.config?.clientId);
    if (!clientId || !token.refreshToken) {
      this.database.updateAccountStatus(account.id, "expired");
      throw new Error("X 授权已到期，请重新连接 X。");
    }
    try {
      const refreshed = await this.refreshToken(clientId, token.refreshToken, signal);
      const keychainAccount = await this.secrets.setConnectorSecret("x", account.id, JSON.stringify(refreshed));
      this.database.saveAccount({ ...account, keychainAccount, status: "active" });
      return refreshed;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof XApiError && (error.status === 400 || error.status === 401)) this.database.updateAccountStatus(account.id, "expired");
      throw error;
    }
  }

  private async waitForAuthorizationCode(url: string, expectedState: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (complete: () => void, response?: ServerResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        server.close();
        // Allow the tiny callback response to flush before closing other
        // connections. Failed/cancelled waits have no response to preserve.
        if (response && !response.writableFinished) {
          response.once("finish", () => server.closeAllConnections());
          response.once("close", () => server.closeAllConnections());
        } else server.closeAllConnections();
        complete();
      };
      const onAbort = () => finish(() => reject(abortError(signal!)));
      const reply = (response: ServerResponse, status: number, message: string) => {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" });
        response.end(message);
      };
      const server = createServer((request, response) => {
        if (settled) { reply(response, 410, "授权请求已结束。"); return; }
        let callback: URL;
        try { callback = new URL(request.url || "/", REDIRECT_URI); }
        catch { reply(response, 400, "授权回调地址无效。"); return; }
        if (callback.origin !== new URL(REDIRECT_URI).origin || callback.pathname !== "/x/callback") {
          reply(response, 404, "未找到授权回调。"); return;
        }
        if (request.method !== "GET") { reply(response, 405, "授权回调需要 GET 请求。"); return; }
        const params = callback.searchParams;
        if (params.getAll("state").length !== 1 || params.get("state") !== expectedState) {
          // Unrelated local traffic must not consume the user's real login.
          reply(response, 400, "授权状态校验失败。"); return;
        }
        const code = params.get("code");
        let failure: string | undefined;
        if (params.getAll("code").length > 1 || params.getAll("error").length > 1 || (params.has("error") && params.has("code"))) failure = "X 授权回调参数无效，请重试。";
        else if (params.has("error")) failure = "X 授权被取消或拒绝，请重新授权。";
        else if (!code?.trim()) failure = "X 未返回授权码，请重试。";
        reply(response, failure ? 400 : 200, failure || "Reading Hub 已收到 X 授权。你可以关闭此页面并回到应用。");
        finish(() => failure ? reject(new Error(failure)) : resolve(code!), response);
      });
      const onServerError = (error: NodeJS.ErrnoException) => finish(() => reject(new Error(
        error.code === "EADDRINUSE" ? "X 授权回调端口已被占用，请关闭其他授权请求后重试。" : "无法启动 X 授权回调，请稍后重试。"
      )));
      server.on("error", onServerError);
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => finish(() => reject(new Error("等待 X 授权超时，请重试。"))), 5 * 60_000);
      try {
        server.listen(43119, "127.0.0.1", () => {
          if (settled) { server.close(); return; }
          void Promise.resolve().then(() => settled ? undefined : this.openExternal(url)).catch(() =>
            finish(() => reject(new Error("无法打开 X 授权页面，请稍后重试。"))));
        });
      } catch (error) { onServerError(error as NodeJS.ErrnoException); }
    });
  }

  private async exchangeAuthorizationCode(clientId: string, code: string, verifier: string, signal?: AbortSignal): Promise<XToken> {
    return this.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT_URI, code_verifier: verifier
    }), signal);
  }

  private async refreshToken(clientId: string, refreshToken: string, signal?: AbortSignal): Promise<XToken> {
    const refreshed = await this.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }), signal);
    // OAuth permits a successful refresh without issuing a replacement refresh
    // token. Only a newly issued token supersedes the current one.
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
  }

  private async exchangeToken(body: URLSearchParams, signal?: AbortSignal): Promise<XToken> {
    let result: { response: Response; payload: unknown };
    try {
      result = await requestJsonWithTimeout(this.fetchX, X_TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body
      }, signal, 20_000);
    } catch (error) {
      throwIfAborted(signal);
      // Do not expose a network exception: it can contain request metadata
      // including OAuth parameters. The caller only needs a useful next step.
      if (error instanceof InvalidJsonResponseError || error instanceof ApiRequestBoundaryError) throw new XApiError(error.message);
      throw new XApiError("无法连接到 X OAuth 令牌服务。请检查系统代理、VPN、DNS 或网络访问后重试。");
    }
    const { response, payload } = result;
    if (!response.ok) {
      throw new XApiError(
        response.status === 400
          ? "X OAuth 配置或授权码无效。请确认已启用 OAuth 2.0、回调地址完全匹配，然后重新授权。"
          : `X OAuth 令牌交换失败（HTTP ${response.status}）。请检查应用权限和 X Developer 账户状态。`,
        response.status
      );
    }
    const token = decodeXTokenResponse(payload);
    if (!token) throw new XApiError("X OAuth 令牌响应无效，请稍后重试；本地授权信息未被覆盖。");
    return token;
  }

  private async requestJson<T>(path: string, accessToken: string, signal?: AbortSignal): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), `${X_API_ROOT}/`);
    if (url.protocol !== "https:" || url.hostname !== "api.x.com") throw new Error("X 连接器拒绝访问未授权域名。");
    let result: { response: Response; payload: T };
    try {
      result = await requestJsonWithTimeout<T>(this.fetchX, url.toString(), {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` }
      }, signal, 20_000);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof InvalidJsonResponseError || error instanceof ApiRequestBoundaryError) throw new XApiError(error.message);
      throw new XApiError("无法连接到 X API。请检查系统代理、VPN、DNS 或网络访问后重试。");
    }
    const { response, payload } = result;
    if (!response.ok) throw new XApiError(xHttpFailureMessage(response.status, path), response.status);
    assertCompleteXResponse(payload);
    return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keep opaque credentials unchanged, but never accept values unsafe in headers. */
function isTokenString(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
}

/** The same stored-token contract applies to Keychain reads and new responses. */
function decodeXToken(value: unknown): XToken | undefined {
  if (!isRecord(value)) return undefined;
  const { accessToken, refreshToken, expiresAt } = value;
  if (!isTokenString(accessToken)
    || (refreshToken !== undefined && !isTokenString(refreshToken))
    || (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0))) return undefined;
  return { accessToken, refreshToken, expiresAt };
}

function decodeXTokenResponse(value: unknown): XToken | undefined {
  if (!isRecord(value) || value.error !== undefined
    || (value.token_type !== undefined && (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"))) return undefined;
  const lifetime = value.expires_in;
  if (lifetime !== undefined && (typeof lifetime !== "number" || !Number.isSafeInteger(lifetime) || lifetime < 0)) return undefined;
  return decodeXToken({
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: lifetime === undefined ? undefined : Date.now() + lifetime * 1000
  });
}

function invalidXResponse(): XApiError {
  // A successful HTTP response with an invalid shape is not evidence of
  // expired credentials. Do not attach a status or any remote response text.
  return new XApiError("X 接口返回的数据不完整或格式错误，已保留同步进度，请稍后重试。");
}

function assertCompleteXResponse(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0))) {
    throw invalidXResponse();
  }
}

/** Validate a whole page before allowing any of its records to advance a cursor. */
function readXPage<T>(value: unknown, isItem: (item: unknown) => item is T): { items: T[]; cursor?: string } {
  assertCompleteXResponse(value);
  const meta = value.meta === undefined ? {} : value.meta;
  if (!isRecord(meta)) throw invalidXResponse();
  const count = meta.result_count;
  if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw invalidXResponse();
  const cursor = stringValue(meta.next_token);
  if (meta.next_token !== undefined && !cursor) throw invalidXResponse();
  // X can omit data on a confirmed zero-result page. Such a page may still
  // carry a next_token; an empty result alone never ends pagination.
  const items = value.data === undefined && count === 0 ? [] : value.data;
  if (!Array.isArray(items) || !items.every(isItem) || (count !== undefined && count !== items.length)) throw invalidXResponse();
  return { items, cursor };
}

function isXUser(value: unknown): value is XUser {
  return isRecord(value) && Boolean(stringValue(value.id)) && Boolean(stringValue(value.username))
    && (value.name === undefined || typeof value.name === "string");
}

function isXPost(value: unknown): value is XPost {
  return isRecord(value) && typeof value.id === "string" && /^\d+$/.test(value.id) && Boolean(stringValue(value.text));
}

const X_CONTENT_NORMALIZATION = {
  // X status URLs are the reader target and already contain the provider's
  // stable post ID. Do not rewrite their route or attach generic tracking
  // canonicalisation rules here.
  canonicalizeUrl: (url: string) => url,
  canonicalIdentity: (item: RawEntry) => item.canonicalIdentity || `x:${item.externalId || item.url}`,
  hashMode: "identity" as const,
  providerId: "x" as const,
  providerLabel: "X"
};

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

function decodePostPage(value: unknown): XPostPage | undefined {
  const record = objectValue(value);
  const cursor = stringValue(record.cursor);
  const highWaterId = stringValue(record.highWaterId);
  return cursor && highWaterId ? { cursor, highWaterId } : undefined;
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
