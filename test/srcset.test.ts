import { expect, it } from "vitest";
import { parseSrcset } from "../src/shared/srcset";

it("parses relative URLs and preserves commas inside CDN paths", () => {
  expect(parseSrcset("small.png 320w, ../large.png 1280w, https://cdn.example.com/w_1800,q_90/image.png 1800w")).toEqual([
    { url: "small.png", width: 320 }, { url: "../large.png", width: 1280 },
    { url: "https://cdn.example.com/w_1800,q_90/image.png", width: 1800 }
  ]);
});

it("supports all ASCII whitespace, trailing commas, and implicit density", () => {
  expect(parseSrcset(" ,\tfirst.png,,\n second.png\f1.5x,\r third.png 2e0x,")).toEqual([
    { url: "first.png", density: 1 }, { url: "second.png", density: 1.5 }, { url: "third.png", density: 2 }
  ]);
});

it("separates syntax from resource permission and URL resolution", () => {
  expect(parseSrcset("data:image/png;base64,AAAA 1x, http://127.0.0.1/private.png 2x")).toEqual([
    { url: "data:image/png;base64,AAAA", density: 1 }, { url: "http://127.0.0.1/private.png", density: 2 }
  ]);
});

it.each(["0w", "-1w", "1.5w", "10oops", "1x 2x", "1w 2x", "2x 1w", "1w 2w", "1h", "1x 2h", "0h 2w", "-1x", "+2x", "Infinityx", "1e400x", "1.x"])("discards an invalid %s descriptor while retaining the next candidate", (descriptor) => {
  expect(parseSrcset(`bad.png ${descriptor}, good.png 2x`)).toEqual([{ url: "good.png", density: 2 }]);
});

it("retains fractional and zero density without rounding", () => {
  expect(parseSrcset("a.png .5x, b.png 1.25x, c.png 0x")).toEqual([
    { url: "a.png", density: 0.5 }, { url: "b.png", density: 1.25 }, { url: "c.png", density: 0 }
  ]);
});

it("accepts the future height descriptor only with one width", () => {
  expect(parseSrcset("a.png 400w 200h, b.png 200h 800w, bad.png 400w 2h 3h")).toEqual([
    { url: "a.png", width: 400 }, { url: "b.png", width: 800 }
  ]);
});

it("does not split a descriptor at commas inside parentheses", () => {
  expect(parseSrcset("bad.png fn(1, 2), good.png 2x")).toEqual([{ url: "good.png", density: 2 }]);
  expect(parseSrcset("bad.png fn(1, good.png 2x")).toEqual([]);
});

it("does not invent candidate boundaries inside an unseparated URL", () => {
  expect(parseSrcset("first.png,second.png")).toEqual([{ url: "first.png,second.png", density: 1 }]);
});

it.each([undefined, "", " , , \n\t"])("accepts empty input %s", (input) => {
  expect(parseSrcset(input)).toEqual([]);
});
