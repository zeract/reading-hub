import { afterEach, expect, it, vi } from "vitest";
import { ReadingDatabase } from "../src/main/database";
import { SourceService } from "../src/main/source-service";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["scheduled", "error", "paused", "disabled", "review", "manual"])("preserves a %s source when its subscription state is unchanged", async (state) => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const db = new ReadingDatabase(":memory:");
  const sync = { cancelSource: vi.fn() };
  const service = new SourceService(db, undefined as never, sync as never, undefined as never);
  try {
    let source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: state === "manual" ? "manual" : state === "review" ? "generic" : "rss", pollingEnabled: !["manual", "disabled"].includes(state) });
    if (state === "scheduled") source = db.markSuccess(source, {});
    if (state === "error") source = db.markFailure(source, "Fixture offline");
    if (state === "paused") source = db.pauseSource(source.id, "Fixture pause");
    if (state === "review") source = db.markSuccess(source, { requiresReview: true });
    const subscription = db.getSubscriptionForSource(source.id);
    const revision = db.getLibraryRevision();
    const due = db.listDueSources();
    vi.setSystemTime(Date.now() + 1_000);
    expect(db.setSubscribed(source.id, true)).toEqual(source);
    expect(await service.setSubscribed(source.id, true)).toEqual(source);
    expect(db.getSubscriptionForSource(source.id)).toEqual(subscription);
    expect(db.getLibraryRevision()).toBe(revision);
    expect(db.listDueSources()).toEqual(due);
    expect(sync.cancelSource).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it("deletes once and makes a repeated deletion a no-op", async () => {
  const db = new ReadingDatabase(":memory:");
  const sync = { cancelSource: vi.fn() };
  const service = new SourceService(db, undefined as never, sync as never, undefined as never);
  try {
    const source = db.createSource({ url: "https://example.com/feed", title: "Fixture", kind: "rss", pollingEnabled: true });
    await service.setSubscribed(source.id, false);
    expect(db.getSource(source.id)).toBeUndefined();
    const revision = db.getLibraryRevision();
    await service.delete(source.id);
    expect(db.getLibraryRevision()).toBe(revision);
    expect(sync.cancelSource).toHaveBeenCalledExactlyOnceWith(source.id);
    await expect(service.setSubscribed(source.id, true)).rejects.toThrow("来源不存在");
  } finally { db.close(); }
});

it("retries failed session cleanup without rewriting the cancelled subscription", async () => {
  const db = new ReadingDatabase(":memory:");
  const sync = { cancelSource: vi.fn() };
  const clearSession = vi.fn().mockRejectedValueOnce(new Error("Fixture cleanup failed")).mockResolvedValue(undefined);
  const service = new SourceService(db, undefined as never, sync as never, { clearSession } as never);
  try {
    const source = db.createSource({ url: "https://www.zhihu.com/follow", title: "Fixture", kind: "zhihu_follow", pollingEnabled: true });
    await expect(service.setSubscribed(source.id, false)).rejects.toThrow("Fixture cleanup failed");
    const stopped = db.getSource(source.id);
    const revision = db.getLibraryRevision();
    expect(stopped?.subscribed).toBe(false);
    await service.delete(source.id);
    expect(db.getSource(source.id)).toBeUndefined();
    expect(clearSession).toHaveBeenCalledTimes(2);
    expect(sync.cancelSource).toHaveBeenCalledTimes(2);
    expect(db.getLibraryRevision()).toBeGreaterThan(revision);
  } finally { db.close(); }
});
