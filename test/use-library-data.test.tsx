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
  it("defaults to collection order and performs no idle full reload", async () => {
    expect(library.libraryView).toBe("collected");
    expect(listPage.mock.lastCall?.[0]).toMatchObject({ collection: "current", sort: "collected" });
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
    await act(async () => library.reload());
    expect(library.reloadError).toBeUndefined();
  });
});
