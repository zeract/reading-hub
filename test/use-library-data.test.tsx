// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryData } from "../src/renderer/use-library-data";
import type { Entry, EntryPage, EntryPageQuery } from "../src/shared/types";

let library: ReturnType<typeof useLibraryData>;
let root: Root;
let container: HTMLDivElement;
let records: Entry[];
let listPage: ReturnType<typeof vi.fn>;
function Harness() { library = useLibraryData(); return null; }

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  records = Array.from({ length: 205 }, (_, index) => ({
    id: String(index), title: String(index), sourceId: "source", url: `https://example.com/${index}`,
    canonicalUrl: `https://example.com/${index}`, contentHash: String(index),
    read: false, favorite: false, createdAt: Date.now()
  }));
  listPage = vi.fn(async (query: EntryPageQuery): Promise<EntryPage> => {
    const filtered = records.filter((entry) => query.read === undefined || entry.read === query.read);
    const start = query.cursor ? filtered.findIndex((entry) => entry.id === query.cursor!.id) + 1 : 0;
    const entries = filtered.slice(start, start + (query.pageSize ?? 100));
    const last = entries.at(-1);
    return { entries, nextCursor: last && start + entries.length < filtered.length
      ? { id: last.id, observedAt: last.createdAt, createdAt: last.createdAt } : undefined };
  });
  Object.defineProperty(window, "reader", { configurable: true, value: {
    getLibraryRevision: vi.fn(async () => 0),
    onLibraryChanged: vi.fn(() => () => undefined),
    listSources: vi.fn(async () => []),
    listEntryPage: listPage,
    getLibraryCounts: vi.fn(async () => ({ unread: 0, favorite: 0, today: 0 }))
  } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("library read-model", () => {
  it("owns page failure without invalidating existing cards or counts and retries the same cursor", async () => {
    const before = library.entries;
    listPage.mockRejectedValueOnce(new Error("Next page unavailable"));
    await act(async () => library.loadMoreEntries());
    const failedQuery = listPage.mock.lastCall![0];
    expect(library.paginationError).toBe("Next page unavailable");
    expect(library.reloadError).toBeUndefined();
    expect(library.entryLoadFailed).toBe(false);
    expect(library.libraryCountsStale).toBe(false);
    expect(library.entries).toBe(before);
    expect(library.hasMoreEntries).toBe(true);
    expect(library.loadingMoreEntries).toBe(false);
    await act(async () => library.loadMoreEntries());
    expect(listPage.mock.lastCall![0]).toEqual(failedQuery);
    expect(library.entries).toHaveLength(200);
    expect(library.paginationError).toBeUndefined();
  });

  it.each(["refresh", "navigation"])("clears page failure after %s replaces its query result", async (action) => {
    listPage.mockRejectedValueOnce(new Error("Next page unavailable"));
    await act(async () => library.loadMoreEntries());
    expect(library.paginationError).toBe("Next page unavailable");
    await act(async () => action === "refresh" ? library.reload() : library.selectSource("other"));
    expect(library.paginationError).toBeUndefined();
  });

  it.each(["refresh", "navigation", "unmount"])("ignores a delayed page failure after %s", async (action) => {
    let reject!: (error: Error) => void;
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((_resolve, fail) => { reject = fail; }));
    let loading!: Promise<void>;
    await act(async () => { loading = library.loadMoreEntries(); });
    await act(async () => {
      if (action === "refresh") await library.reload();
      else if (action === "navigation") library.selectSource("other");
      else root.render(null);
    });
    await act(async () => { reject(new Error("Obsolete page failure")); await loading; });
    expect(library.paginationError).toBeUndefined();
    expect(library.reloadError).toBeUndefined();
  });

  it("keeps failed counts stale through notice dismissal and retry until a successful read", async () => {
    expect(library.libraryCountsStale).toBe(false);
    listPage.mockRejectedValueOnce(new Error("List unavailable"));
    await act(async () => { await library.reload().catch(() => undefined); });
    expect(library.libraryCountsStale).toBe(true);
    await act(async () => library.clearReloadError());
    expect(library.libraryCountsStale).toBe(true);
    let finish!: (page: EntryPage) => void;
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((resolve) => { finish = resolve; }));
    let retried!: Promise<void>;
    await act(async () => { retried = library.reload(); });
    expect(library.loadingEntries).toBe(true);
    expect(library.libraryCountsStale).toBe(true);
    await act(async () => { finish({ entries: records.slice(0, 100) }); await retried; });
    expect(library.libraryCountsStale).toBe(false);
  });

  it("retains a committed flag in visible cards when the following refresh fails", async () => {
    const original = library.entries;
    const apply = library.applyEntryState;
    listPage.mockRejectedValueOnce(new Error("List unavailable"));
    await act(async () => {
      library.applyEntryState(original[0].id, "favorite", true);
      await expect(library.reload()).rejects.toThrow("List unavailable");
    });
    expect(library.entries[0]).toEqual({ ...original[0], favorite: true });
    expect(library.entries[1]).toBe(original[1]);
    expect(original[0].favorite).toBe(false);
    expect(library.entryLoadFailed).toBe(true);
    expect(library.applyEntryState).toBe(apply);
  });

  it("merges independent committed fields and leaves absent or unchanged entries alone", async () => {
    const before = library.entries;
    await act(async () => {
      library.applyEntryState("missing", "read", true);
      library.applyEntryState(before[0].id, "favorite", false);
    });
    expect(library.entries).toBe(before);
    await act(async () => {
      library.applyEntryState(before[0].id, "read", true);
      library.applyEntryState(before[0].id, "favorite", true);
      library.applyEntryState(before[1].id, "favorite", true);
    });
    expect(library.entries[0]).toMatchObject({ read: true, favorite: true });
    expect(library.entries[1]).toMatchObject({ read: false, favorite: true });
    expect(library.entries[2]).toBe(before[2]);
  });

  it("rejects a pre-write list response and reconciles with the next successful read", async () => {
    let finishOld!: (page: EntryPage) => void;
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((resolve) => { finishOld = resolve; }));
    await act(async () => { void library.reload(); });
    const oldEntries = library.entries;
    listPage.mockRejectedValueOnce(new Error("Temporary read failure"));
    await act(async () => {
      library.applyEntryState(oldEntries[0].id, "read", true);
      await library.reload().catch(() => undefined);
    });
    await act(async () => finishOld({ entries: oldEntries }));
    expect(library.entries[0].read).toBe(true);
    // A later authoritative read may contain changes made elsewhere; local
    // patches must not become a permanent overlay that hides them.
    await act(async () => library.reload());
    expect(library.entries[0].read).toBe(false);
    expect(library.entryLoadFailed).toBe(false);
  });

  it("keeps loading active until the current query finishes despite an older completion", async () => {
    let finishOld!: (page: EntryPage) => void;
    let finishCurrent!: (page: EntryPage) => void;
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((resolve) => { finishOld = resolve; }));
    await act(async () => { void library.reload(); });
    expect(library.loadingEntries).toBe(true);
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((resolve) => { finishCurrent = resolve; }));
    await act(async () => library.selectSource("next"));
    await act(async () => finishOld({ entries: [] }));
    expect(library.loadingEntries).toBe(true);
    await act(async () => finishCurrent({ entries: [] }));
    expect(library.loadingEntries).toBe(false);
  });
  it("uses the current selection when a retained reload runs after navigation", async () => {
    await act(async () => library.selectSource("previous"));
    const afterMutation = library.reload;
    await act(async () => library.selectSource("current"));
    await act(async () => library.setEntrySearch("current query"));
    await act(async () => afterMutation());
    expect(library.activeSourceId).toBe("current");
    expect(listPage.mock.lastCall?.[0]).toMatchObject({ sourceId: "current", search: "current query" });
  });

  it("uses a navigation accepted earlier in the same batch for refresh", async () => {
    listPage.mockClear();
    await act(async () => { library.selectSource("next"); await library.reload(); });
    expect(listPage.mock.calls.every(([query]) => query.sourceId === "next")).toBe(true);
    expect(listPage.mock.lastCall?.[0]).toMatchObject({ sourceId: "next" });
  });

  it("applies a retained search callback to the current library view", async () => {
    const search = library.setEntrySearch;
    await act(async () => library.selectLibrary("favorite"));
    await act(async () => search("latest"));
    expect(library.libraryView).toBe("favorite");
    expect(listPage.mock.lastCall?.[0]).toMatchObject({ favorite: true, search: "latest" });
  });

  it("does not clear a different source when an older unsubscribe completes", async () => {
    await act(async () => library.selectSource("previous"));
    const clear = library.clearActiveSource;
    await act(async () => library.selectSource("current"));
    await act(async () => library.setEntrySearch("draft"));
    await act(async () => clear("previous"));
    expect(library.activeSourceId).toBe("current"); expect(library.entrySearch).toBe("draft");
    await act(async () => clear("current"));
    expect(library.activeSourceId).toBeUndefined(); expect(library.entrySearch).toBe("");
  });

  it("defaults to the local collection day and performs no idle full reload", async () => {
    expect(library.libraryView).toBe("today");
    expect(listPage.mock.lastCall?.[0]).toMatchObject({ collectedToday: true });
    vi.useFakeTimers();
    await act(async () => library.selectSource("for-timer"));
    listPage.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(listPage).not.toHaveBeenCalled();
  });

  it("coalesces mutation notifications and removes listeners when unmounted", async () => {
    vi.useFakeTimers();
    let notify!: (revision: number) => void;
    const unsubscribe = vi.fn();
    vi.mocked(window.reader.onLibraryChanged).mockImplementation((listener) => { notify = listener; return unsubscribe; });
    await act(async () => library.selectSource("notifications"));
    listPage.mockClear();
    await act(async () => { notify(1); notify(2); await vi.advanceTimersByTimeAsync(100); });
    expect(listPage).toHaveBeenCalledTimes(1);
    await act(async () => library.selectSource("next"));
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("refreshes today's query boundary after midnight", async () => {
    await act(async () => library.selectLibrary("today"));
    const before = listPage.mock.lastCall![0];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(before.endAt + 1));
    await act(async () => library.reload());
    expect(listPage.mock.lastCall?.[0].startAt).toBe(before.endAt);
  });

  it("does not apply an older refresh after navigating to another source", async () => {
    let resolve!: (page: EntryPage) => void;
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((release) => { resolve = release; }));
    let refreshing!: Promise<void>;
    await act(async () => { refreshing = library.reload(); });
    await act(async () => library.selectSource("other"));
    await act(async () => { resolve({ entries: [{ ...records[0], id: "stale" }] }); await refreshing; });
    expect(library.activeSourceId).toBe("other");
    expect(library.entries.some((entry) => entry.id === "stale")).toBe(false);
  });

  it("revalidates loaded history so deleted and filtered cards do not reappear", async () => {
    await act(async () => library.selectLibrary("unread"));
    await act(async () => library.loadMoreEntries());
    expect(library.entries).toHaveLength(200);
    records = records.filter((entry) => entry.id !== "130");
    records = records.map((entry) => entry.id === "150" ? { ...entry, read: true } : entry);
    await act(async () => library.reload());
    expect(library.entries).toHaveLength(200);
    expect(library.entries.some((entry) => entry.id === "130" || entry.id === "150")).toBe(false);
    expect(library.entries.at(-1)?.id).toBe("201");
  });

  it("discards an older page request after an authoritative refresh", async () => {
    let resolve!: (page: EntryPage) => void;
    listPage.mockImplementationOnce(() => new Promise<EntryPage>((release) => { resolve = release; }));
    let loading!: Promise<void>;
    await act(async () => { loading = library.loadMoreEntries(); });
    records = records.filter((entry) => entry.id !== "150");
    await act(async () => library.reload());
    await act(async () => { resolve({ entries: [{ ...records[0], id: "150" }] }); await loading; });
    expect(library.entries.some((entry) => entry.id === "150")).toBe(false);
    expect(library.loadingMoreEntries).toBe(false);
  });

  it("retains visible cards and exposes a retryable reload error, then clears it on success", async () => {
    listPage.mockRejectedValueOnce(new Error("IPC temporarily unavailable"));
    await act(async () => { await expect(library.reload()).rejects.toThrow("IPC temporarily unavailable"); });
    expect(library.entries).toHaveLength(100);
    expect(library.reloadError).toBe("IPC temporarily unavailable");
    expect(library.loadingEntries).toBe(false);
    expect(library.entryLoadFailed).toBe(true);
    await act(async () => library.clearReloadError());
    expect(library.reloadError).toBeUndefined(); expect(library.entryLoadFailed).toBe(true);
    await act(async () => library.reload());
    expect(library.reloadError).toBeUndefined();
    expect(library.entryLoadFailed).toBe(false);
  });
});
