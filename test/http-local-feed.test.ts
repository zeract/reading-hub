import { describe, expect, it, vi } from "vitest";

const chromiumFetch = vi.hoisted(() => vi.fn());

vi.mock("../src/main/network", () => ({ chromiumFetch }));

import { PublicHttpClient } from "../src/main/http";

describe("PublicHttpClient local-feed boundary", () => {
  it("reads only an explicitly enabled loopback Feed without consulting remote robots", async () => {
    const robots = { assertAllowed: vi.fn() };
    chromiumFetch.mockResolvedValueOnce(new Response("<rss version=\"2.0\"><channel /></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    }));

    const client = new PublicHttpClient(robots as never);
    await expect(client.getText("http://127.0.0.1:1200/twitter/user/example", undefined, {
      allowTrustedLoopbackFeed: true
    })).resolves.toMatchObject({ status: 200, contentType: "application/rss+xml" });

    expect(robots.assertAllowed).not.toHaveBeenCalled();
    expect(chromiumFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:1200/twitter/user/example",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("does not permit a local Feed to escape its loopback origin through redirects", async () => {
    const robots = { assertAllowed: vi.fn() };
    chromiumFetch.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://example.com/feed.xml" }
    }));
    const client = new PublicHttpClient(robots as never);

    await expect(client.getText("http://127.0.0.1:1200/feed", undefined, {
      allowTrustedLoopbackFeed: true
    })).rejects.toThrow("本机 Feed 不能重定向到其他地址");
  });
});
