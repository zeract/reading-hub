import { expect, it, vi } from "vitest";
import { AccessChallengeError, assertNoAccessChallenge, observeAccessChallenges } from "../src/main/access-challenge";
import { ArticleReader } from "../src/main/article-reader";
import { readerFailureDiagnostic } from "../src/main/reader-diagnostics";
import { RobotsChallengeError } from "../src/main/robots";
import { readerImageFailure } from "../src/main/reader-image-retry";

it.each([['x-amzn-waf-action','challenge'],['x-amzn-waf-action','captcha'],['cf-mitigated','challenge']])("recognizes explicit %s=%s without retaining headers", (name,value) => {
  const headers = new Headers({ [name]: value, 'set-cookie':'private-token', location:'https://private.example/' });
  expect(() => assertNoAccessChallenge(headers)).toThrow(AccessChallengeError);
  try { assertNoAccessChallenge(headers); } catch (e) { expect(String(e)).not.toMatch(/private/); }
});
it("does not guess a challenge from an unrelated header or prose", () => {
  expect(() => assertNoAccessChallenge(new Headers({ server:'cloudflare', 'x-description':'captcha', 'cf-mitigated':'none' }))).not.toThrow();
});
it("ignores subresource challenges and disposes its single owned listener", () => {
  let headers: any;
  const blocked = vi.fn(), request = { onHeadersReceived: vi.fn(fn => { headers = fn; }) };
  const dispose = observeAccessChallenges(request as never, blocked), callback = vi.fn();
  headers({ resourceType:'image', responseHeaders:{'cf-mitigated':['challenge']} },callback);
  expect(blocked).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledWith({});
  dispose(); expect(request.onHeadersReceived).toHaveBeenLastCalledWith(null);
});
it("does not launch Chromium after an explicit challenge, but preserves subscription fallback", async () => {
  const entry = { id:'fixture',url:'https://example.com/article',title:'Fixture',summary:'Existing Feed summary from the subscribed source, never a complete article.',sourceId:'feed' } as any;
  const source = { id:'feed',kind:'rss',url:'https://example.com/feed' } as any;
  const renderer = { render:vi.fn() }, http = { getText:vi.fn().mockRejectedValue(new AccessChallengeError()) };
  const reader = new ArticleReader(http as never,renderer as never);
  await expect(reader.read(entry)).rejects.toBeInstanceOf(AccessChallengeError);
  const article = await reader.read(entry,source);
  expect(article.contentMode).toBe('feed_summary'); expect(renderer.render).not.toHaveBeenCalled();
});
it("keeps page and robots challenges separate from content loss and transient network errors", () => {
  for (const error of [new AccessChallengeError(),new RobotsChallengeError()]) {
    expect(readerFailureDiagnostic('static',error)).toEqual({stage:'static',reason:'access_challenge'});
    expect(readerImageFailure(error)).toEqual({reason:'access_challenge',retryable:false});
  }
});
