import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, EntryListQuery, EntryPageCursor, LibraryCounts, Source } from "../shared/types";
import { mergeEntryPages, nextEntryPageQuery, readLoadedEntryPages } from "./entry-pagination";
import { errorMessage } from "./errors";
import { entryQueryForLibrary, type LibraryView } from "./library-view";
import { groupSources } from "./source-groups";
import { isSameLibrarySelection, type LibrarySelection } from "./source-selection";

const EMPTY_LIBRARY_COUNTS: LibraryCounts = { unread: 0, favorite: 0, today: 0 };

/**
 * Keeps the read-model and navigation query in one place. The app shell owns
 * workflow state (dialogs, notices and the selected reader entry), while this
 * hook guarantees that out-of-order IPC results cannot replace newer results.
 */
export function useLibraryData() {
  const [sources, setSources] = useState<Source[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [libraryCounts, setLibraryCounts] = useState<LibraryCounts>(EMPTY_LIBRARY_COUNTS);
  const [nextEntryCursor, setNextEntryCursor] = useState<EntryPageCursor>();
  const [loadingMoreEntries, setLoadingMoreEntries] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const [entryLoadState, setEntryLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [selection, setSelection] = useState<LibrarySelection>({ view: "collected", search: "" });
  const { sourceId: activeSourceId, view: libraryView, search: entrySearch } = selection;
  // Navigation owns one complete query scope. Keep its accepted value
  // available before React renders so retained callbacks cannot reload an
  // obsolete source, filter, or search after an asynchronous mutation.
  const currentSelection = useRef(selection);
  const reloadSequence = useRef(0);
  const pageGeneration = useRef(0);
  const loadedPageCount = useRef(1);
  const loadedQuery = useRef<EntryListQuery | undefined>(undefined);
  const loadingMore = useRef(false);
  const reloading = useRef(false);
  const lastRevision = useRef<number | undefined>(undefined);

  // Called only after a successful write, before reload invalidates in-flight
  // reads. Keep visible cards current even if that follow-up read fails.
  const applyEntryState = useCallback((entryId: string, field: "read" | "favorite", value: boolean) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.id === entryId);
      if (index < 0 || current[index][field] === value) return current;
      const next = [...current];
      next[index] = { ...current[index], [field]: value };
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const generation = ++pageGeneration.current;
    const isCurrent = () => sequence === reloadSequence.current && generation === pageGeneration.current;
    // Recompute today's range on refresh, including when the app stays open overnight.
    const current = currentSelection.current;
    const query = entryQueryForLibrary(current.view, current.sourceId, new Date(), current.search);
    const pageCount = JSON.stringify(query) === JSON.stringify(loadedQuery.current) ? loadedPageCount.current : 1;
    reloading.current = true;
    setEntryLoadState("loading");
    loadingMore.current = false;
    setLoadingMoreEntries(false);
    try {
      const revision = await window.reader.getLibraryRevision?.();
      if (!isCurrent()) return;
      const [nextSources, nextPage, nextLibraryCounts] = await Promise.all([
        window.reader.listSources(),
        readLoadedEntryPages(query, pageCount, (page) => window.reader.listEntryPage(page), isCurrent),
        window.reader.getLibraryCounts()
      ]);
      if (!isCurrent() || !nextPage) return;
      lastRevision.current = revision;
      loadedPageCount.current = nextPage.pageCount;
      loadedQuery.current = query;
      setSources(nextSources);
      setEntries(nextPage.entries);
      setNextEntryCursor(nextPage.nextCursor);
      setLibraryCounts(nextLibraryCounts);
      setReloadError(undefined);
      setEntryLoadState("ready");
    } catch (error) {
      if (!isCurrent()) return;
      setReloadError(errorMessage(error));
      setEntryLoadState("error");
      throw error;
    } finally {
      if (isCurrent()) reloading.current = false;
    }
  }, []);

  useEffect(() => {
    // reload owns the visible error state; unattended ticks must not reject globally.
    void reload().catch(() => undefined);
    let active = true;
    let dirty = false;
    let changeTimer: number | undefined;
    const refreshChanged = () => {
      if (!active) return;
      changeTimer = undefined;
      if (reloading.current || loadingMore.current) { changeTimer = window.setTimeout(refreshChanged, 150); return; }
      if (dirty) { dirty = false; void reload().catch(() => undefined); }
    };
    const unsubscribe = window.reader.onLibraryChanged?.((revision) => {
      if (revision === lastRevision.current) return;
      dirty = true;
      if (changeTimer === undefined) changeTimer = window.setTimeout(refreshChanged, 100);
    });
    const timer = window.setInterval(() => {
      if (reloading.current || loadingMore.current) return;
      void Promise.resolve(window.reader.getLibraryRevision?.()).then((revision) => {
        if (!active) return;
        const midnightChanged = libraryView === "today" && loadedQuery.current?.endAt !== undefined && Date.now() >= loadedQuery.current.endAt;
        if (revision !== lastRevision.current || midnightChanged || lastRevision.current === undefined) { dirty = true; refreshChanged(); }
      }).catch(() => undefined);
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(changeTimer);
      unsubscribe?.();
      reloadSequence.current += 1;
      pageGeneration.current += 1;
    };
  }, [reload, selection]);

  const resetEntryPages = useCallback(() => {
    pageGeneration.current += 1;
    loadedPageCount.current = 1;
    loadedQuery.current = undefined;
    reloading.current = false;
    loadingMore.current = false;
    setLoadingMoreEntries(false);
    setNextEntryCursor(undefined);
    setEntries([]);
    setEntryLoadState("loading");
    setReloadError(undefined);
  }, []);

  const navigateLibrary = useCallback((requested: LibrarySelection) => {
    const current = currentSelection.current;
    if (isSameLibrarySelection(current, requested)) {
      // A repeated click leaves React state unchanged, so the query effect
      // will not run. Keep the current list visible while its refresh starts.
      void reload().catch(() => undefined);
      return;
    }
    currentSelection.current = requested;
    resetEntryPages();
    setSelection(requested);
  }, [reload, resetEntryPages]);

  const selectSource = useCallback((sourceId?: string) => {
    navigateLibrary({ view: "all", sourceId, search: "" });
  }, [navigateLibrary]);

  const selectLibrary = useCallback((view: LibraryView) => {
    navigateLibrary({ view, sourceId: undefined, search: "" });
  }, [navigateLibrary]);

  const setEntrySearch = useCallback((search: string) => {
    const current = currentSelection.current;
    if (search === current.search) return;
    navigateLibrary({ ...current, search });
  }, [navigateLibrary]);

  const loadMoreEntries = useCallback(async () => {
    const cursor = nextEntryCursor;
    const query = loadedQuery.current;
    if (!cursor || !query || loadingMore.current || reloading.current) return;
    const generation = pageGeneration.current;
    loadingMore.current = true;
    setLoadingMoreEntries(true);
    try {
      const nextPage = await window.reader.listEntryPage(nextEntryPageQuery(query, cursor));
      if (generation !== pageGeneration.current) return;
      setEntries((current) => mergeEntryPages(current, nextPage.entries));
      setNextEntryCursor(nextPage.nextCursor);
      loadedPageCount.current += 1;
    } catch (error) {
      if (generation === pageGeneration.current) throw error;
    } finally {
      if (generation === pageGeneration.current) {
        loadingMore.current = false;
        setLoadingMoreEntries(false);
      }
    }
  }, [nextEntryCursor]);

  const clearActiveSource = useCallback((sourceId: string) => {
    const current = currentSelection.current;
    if (current.sourceId !== sourceId) return;
    navigateLibrary({ view: current.view, sourceId: undefined, search: "" });
  }, [navigateLibrary]);

  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const activeSource = activeSourceId ? sourceById.get(activeSourceId) : undefined;
  const sourceGroups = useMemo(() => groupSources(sources), [sources]);

  return {
    sources,
    entries,
    hasMoreEntries: Boolean(nextEntryCursor),
    loadingMoreEntries,
    loadingEntries: entryLoadState === "loading",
    entryLoadFailed: entryLoadState === "error",
    reloadError,
    clearReloadError: () => setReloadError(undefined),
    libraryCounts,
    activeSourceId,
    libraryView,
    entrySearch,
    sourceById,
    activeSource,
    sourceGroups,
    applyEntryState,
    reload,
    loadMoreEntries,
    selectSource,
    selectLibrary,
    setEntrySearch,
    clearActiveSource
  };
}
