// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceIcon } from "../src/renderer/ui-icons";
import type { Source } from "../src/shared/types";

const source: Source = { id: "source", url: "https://example.com/feed", title: "Fixture", kind: "rss", status: "active", pollingEnabled: true, consecutiveEmpty: 0, failureCount: 0, createdAt: 1, updatedAt: 1 };
const icon = "data:image/png;base64,ZmFrZQ==";
let container: HTMLDivElement; let root: Root; let load: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  load = vi.fn().mockResolvedValue(icon);
  Object.defineProperty(window, "reader", { configurable: true, value: { loadSourceIcon: load } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(item = source) { await act(async () => root.render(<SourceIcon source={item} />)); }

it("restores the local mark after decoding fails without requesting the same icon again", async () => {
  await render();
  const image = container.querySelector("img")!;
  expect(image.src).toBe(icon);
  await act(async () => image.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".source-icon--rss svg")).not.toBeNull();
  expect(container.querySelector(".source-icon--favicon")).toBeNull();
  await render({ ...source, title: "Renamed" });
  expect(load).toHaveBeenCalledTimes(1);
  expect(container.querySelector("svg")).not.toBeNull();
});

it("permits changed icon metadata to load after an earlier decode failure", async () => {
  await render();
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
  load.mockResolvedValue("data:image/png;base64,bmV3");
  await render({ ...source, iconUrl: "https://example.com/new.png" });
  expect(load).toHaveBeenCalledTimes(2);
  expect(container.querySelector("img")?.src).toBe("data:image/png;base64,bmV3");
});

it("keeps the local mark when the main-process request fails", async () => {
  load.mockRejectedValueOnce(new Error("Synthetic icon failure"));
  await render();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

it("does not let an obsolete image error remove a newer image candidate", async () => {
  await render();
  const previous = container.querySelector("img")!;
  load.mockResolvedValue("data:image/png;base64,bmV3");
  await render({ ...source, iconUrl: "https://example.com/new.png" });
  await act(async () => previous.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")?.src).toBe("data:image/png;base64,bmV3");
});

it("ignores a superseded source response and retains the current icon", async () => {
  let resolve!: (value: string) => void;
  load.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
  await render();
  await render({ ...source, id: "replacement", url: "https://replacement.example/feed" });
  await act(async () => resolve("data:image/png;base64,b2xk"));
  expect(container.querySelector("img")?.src).toBe(icon);
});
