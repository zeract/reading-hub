import { beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/main/network", () => ({ chromiumFetch: network.fetch }));
import { PublicHttpClient } from "../src/main/http";

const referrer = "https://example.com/article";
const url = (id: number) => `https://example.com/image-${id}.png`;
const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);
beforeEach(() => { network.fetch.mockReset(); });

describe("reader image cache retention", () => {
  it("retains a recently viewed image when the entry limit evicts a colder image", async () => {
    network.fetch.mockImplementation(async () => new Response("fixture", { headers: { "content-type": "image/png" } }));
    const http = client();
    for (let index = 0; index < 24; index++) await http.getImageDataUrl(url(index), referrer);
    await http.getImageDataUrl(url(0), referrer);
    await http.getImageDataUrl(url(24), referrer);
    await http.getImageDataUrl(url(0), referrer);
    expect(network.fetch).toHaveBeenCalledTimes(25);
    await http.getImageDataUrl(url(1), referrer);
    expect(network.fetch).toHaveBeenCalledTimes(26);
  });

  it("evicts large encoded images by retained cost before reaching 24 entries", async () => {
    network.fetch.mockImplementation(async () => new Response(new Uint8Array(6_000_000), { headers: { "content-type": "image/png" } }));
    const http = client();
    for (let index = 0; index < 3; index++) await http.getImageDataUrl(url(index), referrer);
    await http.getImageDataUrl(url(2), referrer);
    expect(network.fetch).toHaveBeenCalledTimes(3);
    await http.getImageDataUrl(url(0), referrer);
    expect(network.fetch).toHaveBeenCalledTimes(4);
  });
});
