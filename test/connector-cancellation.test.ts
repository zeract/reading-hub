import { describe, expect, it, vi } from "vitest";
import { AcademicAuthorConnector } from "../src/main/academic";
import { RssConnector } from "../src/main/connectors";
import { ConnectorRegistry } from "../src/main/connector-registry";
import { ReadingDatabase } from "../src/main/database";
import { SyncManager, SyncCancelledError } from "../src/main/sync-manager";
import { requestJsonWithTimeout } from "../src/main/json-response";
vi.mock("../src/main/network", () => ({ chromiumFetch: vi.fn() }));

function library(kind: "rss" | "academic") {
  const db = new ReadingDatabase(":memory:");
  const source = db.createSource({ url: "https://example.com/feed", title: "Test", kind, pollingEnabled: true,
    config: kind === "academic" ? { authorName: "Example", openAlexId: "A123" } : undefined });
  return { db, source, subscription: db.getSubscriptionForSource(source.id)! };
}

describe("connector cancellation and health", () => {
  it("does not report an unconfigured academic provider as a successful request", async () => {
    const { db, source, subscription } = library("academic");
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    try {
      await expect(new AcademicAuthorConnector(fetch).sync({ source, subscription })).rejects.toThrow("503");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("aborts response bodies as well as waiting for headers", async () => {
    const controller = new AbortController();
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(body);
    const pending = requestJsonWithTimeout(async () => response, "https://example.com", {}, controller.signal, 20_000);
    const rejected = expect(pending).rejects.toThrow("cancel body");
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    controller.abort(new Error("cancel body"));
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("shutdown aborts the RSS transport without persisting a failure or checkpoint", async () => {
    const { db, source } = library("rss");
    let signal: AbortSignal | undefined;
    const http = { getText: vi.fn((_url, _cached, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    })) };
    const registry = new ConnectorRegistry();
    registry.register(new RssConnector(http as never));
    const manager = new SyncManager(db, registry);
    try {
      const pending = manager.syncSource(source.id);
      const rejected = expect(pending).rejects.toBeInstanceOf(SyncCancelledError);
      await vi.waitFor(() => expect(http.getText).toHaveBeenCalled());
      await manager.close();
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(db.getSource(source.id)?.failureCount).toBe(0);
      expect(db.listSyncEvents()).toEqual([]);
      expect(db.getCheckpoint(source.id)).toBeUndefined();
    } finally { await manager.close(); db.close(); }
  });
});
