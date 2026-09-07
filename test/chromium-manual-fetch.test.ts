import { Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: { request: native.request } }));
import { chromiumManualFetch } from "../src/main/chromium-manual-fetch";

class NativeRequest extends Writable {
  readonly abort = vi.fn(() => { this.emit("abort"); });
  readonly followRedirect = vi.fn();
  constructor() { super({ autoDestroy: true }); }
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done(); }
}
function fixture() {
  const request = new NativeRequest();
  native.request.mockReturnValue(request);
  const message = Object.assign(new Readable({ read() {} }), { statusCode: 200, statusMessage: "OK", headers: { "content-type": "text/plain" } });
  return { request, message };
}
afterEach(() => native.request.mockReset());

it("returns redirect status and headers while aborting before any destination request", async () => {
  const { request } = fixture();
  const pending = chromiumManualFetch("https://example.com/a", { redirect: "manual", credentials: "omit" });
  request.emit("redirect", 307, "GET", "https://other.example/b", { location: ["https://other.example/b"], "set-cookie": ["one=1", "two=2"] });
  const response = await pending;
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://other.example/b");
  expect(response.headers.getSetCookie()).toEqual(["one=1", "two=2"]);
  expect(response.body).toBeNull();
  expect(request.abort).toHaveBeenCalledTimes(1);
  expect(request.followRedirect).not.toHaveBeenCalled();
  expect(native.request).toHaveBeenCalledTimes(1);
  expect(native.request.mock.calls[0][0]).toMatchObject({ credentials: "omit", redirect: "manual" });
  expect(() => request.emit("error", new Error("late native error"))).not.toThrow();
});

it("keeps reading after the upload Writable closes and delivers streamed bytes", async () => {
  const { request, message } = fixture();
  const pending = chromiumManualFetch("https://example.com/a", { method: "POST", body: "fixture" });
  await vi.waitFor(() => expect(request.closed).toBe(true));
  expect(request.abort).not.toHaveBeenCalled();
  request.emit("response", message);
  const response = await pending;
  const text = response.text();
  message.push(Buffer.from("first ")); message.push(Buffer.from("second")); message.push(null);
  expect(await text).toBe("first second");
  expect(request.abort).not.toHaveBeenCalled();
});

it.each(["before headers", "during body"])("aborts native work on cancellation %s", async (phase) => {
  const { request, message } = fixture();
  const controller = new AbortController();
  const pending = chromiumManualFetch("https://example.com/a", { signal: controller.signal });
  const error = new Error("Fixture cancellation");
  if (phase === "before headers") {
    const rejected = expect(pending).rejects.toThrow(error);
    controller.abort(error); await rejected;
  } else {
    request.emit("response", message);
    const response = await pending;
    const rejected = expect(response.text()).rejects.toThrow(error);
    controller.abort(error); await rejected;
    expect(message.destroyed).toBe(true);
  }
  expect(request.abort).toHaveBeenCalledTimes(1);
});

it("cancels the native request when a consumer discards its body", async () => {
  const { request, message } = fixture();
  const pending = chromiumManualFetch("https://example.com/a", {});
  request.emit("response", message);
  const response = await pending;
  await response.body!.cancel();
  await vi.waitFor(() => expect(request.abort).toHaveBeenCalledTimes(1));
  expect(message.destroyed).toBe(true);
});

it("keeps an unread response under stream backpressure instead of buffering the whole transfer", async () => {
  const { request } = fixture();
  let produced = 0;
  const message = Object.assign(new Readable({
    highWaterMark: 65_536,
    read() {
      produced++;
      this.push(produced <= 256 ? Buffer.alloc(65_536) : null);
    }
  }), { statusCode: 200, statusMessage: "OK", headers: {} });
  const pending = chromiumManualFetch("https://example.com/a", {});
  request.emit("response", message);
  const response = await pending;
  await new Promise((resolve) => setImmediate(resolve));
  expect(produced).toBeGreaterThan(0);
  expect(produced).toBeLessThanOrEqual(3);
  await response.body!.cancel();
  await vi.waitFor(() => expect(request.abort).toHaveBeenCalledTimes(1));
  expect(message.destroyed).toBe(true);
});

it("propagates body failures instead of reporting truncated content as complete", async () => {
  const { request, message } = fixture();
  const pending = chromiumManualFetch("https://example.com/a", {});
  request.emit("response", message);
  const response = await pending;
  const rejected = expect(response.text()).rejects.toThrow("Fixture disconnect");
  message.destroy(new Error("Fixture disconnect")); await rejected;
  expect(request.abort).toHaveBeenCalledTimes(1);
});

it.each([204, 205, 304])("releases a bodyless HTTP %s without creating a reader", async (statusCode) => {
  const { request, message } = fixture(); message.statusCode = statusCode;
  const pending = chromiumManualFetch("https://example.com/a", {});
  request.emit("response", message);
  const response = await pending;
  expect(response.status).toBe(statusCode); expect(response.body).toBeNull();
  expect(request.abort).toHaveBeenCalledTimes(1);
});
