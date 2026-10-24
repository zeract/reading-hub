import { load } from "cheerio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicHttpClient, NetworkRequestError } from "../src/main/http";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("../src/main/network", () => ({ chromiumFetch: fetcher }));
const target = "https://example.com/image.png";
const referrer = "https://example.com/article";
const client = () => new PublicHttpClient({ assertAllowed: vi.fn().mockResolvedValue(undefined) } as never);

describe("bounded image responses", () => {
  afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

  it("stops at the first oversized chunk instead of buffering the complete image", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) controller.enqueue(new Uint8Array(4_000_000));
        else if (pulls === 3) controller.enqueue(new Uint8Array(1));
        else if (pulls === 4) controller.enqueue(new Uint8Array(4_000_000));
        else controller.close();
      }, cancel
    }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png", "content-length": "1" } }));
    await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow("8 MB");
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("cancels a declared oversized body before reading it", async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png", "content-length": "8000001" } }));
    await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow("8 MB");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("encodes successful bytes and reuses only the matching article/image cache entry", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    fetcher.mockImplementation(async () => new Response(bytes, { headers: { "content-type": "image/png" } }));
    const http = client();
    const result = await http.getImageDataUrl(target, referrer);
    expect(result).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(await http.getImageDataUrl(target, referrer)).toBe(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await http.getImageDataUrl(target, "https://example.com/another-article");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts the exact byte limit", async () => {
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(8_000_000), { headers: { "content-type": "image/png" } }));
    const result = await client().getImageDataUrl(target, referrer);
    expect(Buffer.from(result.split(",")[1], "base64").byteLength).toBe(8_000_000);
  });

  it("times out a stalled body even if the transport does not settle cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const bodies: ReadableStream<Uint8Array>[] = [];
    fetcher.mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined), cancel }, { highWaterMark: 0 });
      bodies.push(body); return new Response(body, { headers: { "content-type": "image/png" } });
    });
    const rejected = expect(client().getImageDataUrl(target, referrer)).rejects.toBeInstanceOf(NetworkRequestError);
    await vi.advanceTimersByTimeAsync(40_500);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(bodies.every(body => !body.locked)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a body read at the caller's request and allows a later retry", async () => {
    const cancel = vi.fn();
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    fetcher.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png" } }));
    const http = client();
    const controller = new AbortController();
    const pending = http.getImageDataUrl(target, referrer, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancel image");
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    controller.abort(new Error("cancel image"));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response("fixture", { headers: { "content-type": "image/png" } }));
    await expect(http.getImageDataUrl(target, referrer)).resolves.toContain("data:image/png;base64,");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["redirect", "unsupported", "http-error"])("discards an unread %s body", async (kind) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = kind === "redirect" ? new Response(body, { status: 302, headers: { location: "https://127.0.0.1/private" } })
      : kind === "http-error" ? new Response(body, { status: 403 })
      : new Response(body, { headers: { "content-type": "text/html" } });
    fetcher.mockResolvedValueOnce(response);
    await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("sanitizes a bounded SVG before returning durable image bytes", async () => {
  fetcher.mockResolvedValueOnce(new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><style>text{fill:red}</style><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><defs><path id="glyph" d="M0 0L10 10"/></defs><use href="#glyph"/><use href="https://evil.example/payload.svg#x"/><image href="http://127.0.0.1/private"/><rect width="50" height="50" style="fill:blue;filter:url(https://evil.example/filter)"/><text x="5" y="20">离线图形</text></svg>`, { headers: { "content-type": "image/svg+xml" } }));
  const data = await client().getImageDataUrl(target, referrer);
  expect(data).toMatch(/^data:image\/svg\+xml;base64,/);
  const xml = Buffer.from(data.split(",")[1], "base64").toString();
  expect(xml).toContain('href="#glyph"'); expect(xml).toContain('fill="blue"'); expect(load(xml, { xml: true })('text').text()).toBe('离线图形');
  expect(xml).not.toMatch(/script|foreignObject|onload|evil\.example|127\.0\.0\.1|style=/);
  fetcher.mockResolvedValueOnce(new Response('<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///private/key">]><svg>&secret;</svg>', { headers: { "content-type": "image/svg+xml" } }));
  await expect(client().getImageDataUrl(target, referrer)).rejects.toThrow("文档声明");
});

it.each(['application/octet-stream',''])('recognizes binary raster signatures with generic MIME %s',async type=>{
  const bytes=Buffer.from([255,216,255,224,0,0]);
  fetcher.mockResolvedValueOnce(new Response(bytes,{headers:{'content-type':type}}));
  expect(await client().getImageDataUrl(target,referrer)).toBe('data:image/jpeg;base64,'+bytes.toString('base64'));
});
it.each(['<html>error</html>','<script>alert(1)</script>','not an image'])('does not sniff active or unrecognized generic content',async body=>{
  fetcher.mockResolvedValueOnce(new Response(body,{headers:{'content-type':'application/octet-stream'}}));
  await expect(client().getImageDataUrl(target,referrer)).rejects.toThrow('不是可安全');
});
it.each(['text/plain','application/octet-stream'])('sanitizes mislabeled SVG rather than forwarding active XML (%s)',async type=>{
  fetcher.mockResolvedValueOnce(new Response('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="10" height="10"/></svg>',{headers:{'content-type':type}}));
  const data=await client().getImageDataUrl(target,referrer);
  expect(data).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(Buffer.from(data.split(',')[1],'base64').toString()).not.toMatch(/onload|script|alert/);
});
it('does not reinterpret explicit HTML as a raster image',async()=>{
  fetcher.mockResolvedValueOnce(new Response(Buffer.from([255,216,255]),{headers:{'content-type':'text/html'}}));
  await expect(client().getImageDataUrl(target,referrer)).rejects.toThrow('不是可安全');
});
