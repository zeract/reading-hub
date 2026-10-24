import type { WebRequest } from "electron";

/** Explicit gateway signals only: prose mentioning CAPTCHAs is not a challenge. */
export class AccessChallengeError extends Error {
  constructor() {
    super("该站点要求人机验证，已停止自动读取。请在浏览器中打开原文查看。");
    this.name = "AccessChallengeError";
  }
}

export function assertNoAccessChallenge(headers: Pick<Headers, "get">): void {
  const waf = headers.get("x-amzn-waf-action")?.trim().toLowerCase();
  const mitigated = headers.get("cf-mitigated")?.trim().toLowerCase();
  if (waf === "challenge" || waf === "captcha" || mitigated === "challenge") throw new AccessChallengeError();
}
/** Cancel before a gateway's challenge document is loaded or executed. */
export function observeAccessChallenges(request: Pick<WebRequest, "onHeadersReceived"> | undefined, blocked: (error: AccessChallengeError) => void): () => void {
  request?.onHeadersReceived?.((details, callback) => {
    if (details.resourceType === "mainFrame") {
      const headers = { get: (name: string) => Object.entries(details.responseHeaders ?? {})
        .find(([key]) => key.toLowerCase() === name)?.[1].join(",") ?? null };
      try { assertNoAccessChallenge(headers); }
      catch (error) {
        if (!(error instanceof AccessChallengeError)) throw error;
        blocked(error);
        callback({ cancel: true });
        return;
      }
    }
    callback({});
  });
  return () => request?.onHeadersReceived?.(null);
}
