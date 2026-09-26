import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { RobotsDisallowedError, RobotsNetworkUnavailableError, RobotsPolicy, RobotsRateLimitedError } from "../src/main/robots";
import { PublicHttpClient } from "../src/main/http";

beforeEach(() => { network.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("robots access decisions", () => {
  it("uses the most specific allow rule", async () => {
    network.fetch.mockResolvedValue(new Response("User-agent: *\nDisallow: /\nAllow: /public/"));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/public/post")).resolves.toBeUndefined();
  });

  it("recognizes every agent in a shared group", async () => {
    network.fetch.mockResolvedValue(new Response("User-agent: ReadingHub\nUser-agent: OtherBot\nDisallow: /private"));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/private")).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("uses the specific group instead of wildcard fallback", async () => {
    network.fetch.mockResolvedValue(new Response("User-agent: *\nDisallow: /\nUser-agent: ReadingHub\nDisallow: /private"));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/public")).resolves.toBeUndefined();
  });

  it("matches wildcard and end-of-path restrictions", async () => {
    network.fetch.mockResolvedValue(new Response("User-agent: *\nDisallow: /*.pdf$"));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/archive/paper.pdf")).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("compares percent-encoded unreserved characters consistently", async () => {
    network.fetch.mockResolvedValue(new Response("User-agent: *\nDisallow: /private"));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/%70rivate")).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("does not grant access when robots returns a server error", async () => {
    network.fetch.mockResolvedValue(new Response("fixture private response", { status: 503 }));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("does not grant access when the policy cannot be reached", async () => {
    network.fetch.mockRejectedValue(new Error("fixture private network detail"));
    await expect(new RobotsPolicy().assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsNetworkUnavailableError);
  });

  it("rechecks a formerly offline policy after reconnection and still enforces its rules", async () => {
    const policy = new RobotsPolicy();
    network.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsNetworkUnavailableError);
    policy.forgetTransientFailures();
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /post"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("rechecks an offline policy after a bounded minute even when no connectivity event arrives", async () => {
    vi.useFakeTimers();
    const policy = new RobotsPolicy();
    network.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsNetworkUnavailableError);
    await vi.advanceTimersByTimeAsync(60_000);
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nAllow: /post"));
    await expect(policy.assertAllowed("https://example.com/post")).resolves.toBeUndefined();
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it("rechecks a transient 503 after a real reconnection signal without bypassing robots", async () => {
    const policy = new RobotsPolicy();
    network.fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    policy.forgetTransientFailures();
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /post"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])("blocks HTTP %i without fetching the page, then retries successfully after backoff", async (status) => {
    vi.useFakeTimers();
    network.fetch.mockResolvedValueOnce(new Response("fixture sensitive body", { status }));
    const client = new PublicHttpClient(new RobotsPolicy());
    await expect(client.getText("https://example.com/post")).rejects.toMatchObject({
      name: status === 429 ? "RobotsRateLimitedError" : "RobotsUnreachableError",
      message: status === 429 ? RobotsRateLimitedError.messageText
        : "暂时无法确认该站点的 robots.txt 规则，已停止自动读取，请稍后重试。"
    });
    await vi.advanceTimersByTimeAsync((status === 429 ? 60 : 5) * 60_000 - 1);
    await expect(client.getText("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(network.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nAllow: /post"));
    network.fetch.mockResolvedValueOnce(new Response("<html>fixture page</html>"));
    await expect(client.getText("https://example.com/post")).resolves.toMatchObject({ text: "<html>fixture page</html>" });
    expect(network.fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/robots.txt", "https://example.com/robots.txt", "https://example.com/post"
    ]);
  });

  it("retains a full rate-limit cooldown without treating it as a network recovery", async () => {
    const policy = new RobotsPolicy();
    network.fetch.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsRateLimitedError);
    policy.forgetTransientFailures();
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsRateLimitedError);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it("allows the robots resource itself without a recursive policy fetch", async () => {
    await new RobotsPolicy().assertAllowed("https://example.com/robots.txt");
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it("revalidates a parsed policy after 24 hours and on service restart", async () => {
    vi.useFakeTimers();
    const policy = new RobotsPolicy();
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nAllow: /"));
    await policy.assertAllowed("https://example.com/post");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nDisallow: /post"));
    await expect(policy.assertAllowed("https://example.com/post")).rejects.toBeInstanceOf(RobotsDisallowedError);
    network.fetch.mockResolvedValueOnce(new Response("User-agent: *\nAllow: /post"));
    await new RobotsPolicy().assertAllowed("https://example.com/post");
    expect(network.fetch).toHaveBeenCalledTimes(3);
  });
});
