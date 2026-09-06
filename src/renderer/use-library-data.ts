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
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [libraryView, setLibraryView] = useState<LibraryView>("today");
  const [entrySearch, setEntrySearchState] = useState("");
  const reloadSequence = useRef(0);
  const pageGeneration = useRef(0);
  const loadedPageCount = useRef(1);
  const loadedQuery = useRef<EntryListQuery | undefined>(undefined);
  const loadingMore = useRef(false);
  const reloading = useRef(false);

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const generation = ++pageGeneration.current;
    const isCurrent = () => sequence === reloadSequence.current && generation === pageGeneration.current;
    // Recompute today's range on refresh, including when the app stays open overnight.
    const query = entryQueryForLibrary(libraryView, activeSourceId, new Date(), entrySearch);
    const pageCount = JSON.stringify(query) === JSON.stringify(loadedQuery.current) ? loadedPageCount.current : 1;
    reloading.current = true;
    loadingMore.current = false;
    setLoadingMoreEntries(false);
    try {
      const [nextSources, nextPage, nextLibraryCounts] = await Promise.all([
        window.reader.listSources(),
        readLoadedEntryPages(query, pageCount, (page) => window.reader.listEntryPage(page), isCurrent),
        window.reader.getLibraryCounts()
      ]);
      if (!isCurrent() || !nextPage) return;
      loadedPageCount.current = nextPage.pageCount;
      loadedQuery.current = query;
      setSources(nextSources);
      setEntries(nextPage.entries);
      setNextEntryCursor(nextPage.nextCursor);
      setLibraryCounts(nextLibraryCounts);
      setReloadError(undefined);
    } catch (error) {
      if (!isCurrent()) return;
      setReloadError(errorMessage(error));
      throw error;
    } finally {
      if (isCurrent()) reloading.current = false;
    }
  }, [activeSourceId, entrySearch, libraryView]);

  useEffect(() => {
    // reload owns the visible error state; unattended ticks must not reject globally.
    void reload().catch(() => undefined);
    const timer = window.setInterval(() => {
      if (!reloading.current && !loadingMore.current) void reload().catch(() => undefined);
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      reloadSequence.current += 1;
      pageGeneration.current += 1;
    };
  }, [reload]);

  const resetEntryPages = useCallback(() => {
    pageGeneration.current += 1;
    loadedPageCount.current = 1;
    loadedQuery.current = undefined;
    reloading.current = false;
    loadingMore.current = false;
    setLoadingMoreEntries(false);
    setNextEntryCursor(undefined);
    setEntries([]);
    setReloadError(undefined);
  }, []);

  const navigateLibrary = useCallback((requested: LibrarySelection) => {
    const current: LibrarySelection = { view: libraryView, sourceId: activeSourceId, search: entrySearch };
    if (isSameLibrarySelection(current, requested)) {
      // A repeated click leaves React state unchanged, so the query effect
      // will not run. Keep the current list visible while its refresh starts.
      void reload().catch(() => undefined);
      return;
    }
    resetEntryPages();
    setEntrySearchState(requested.search);
    setActiveSourceId(requested.sourceId);
    setLibraryView(requested.view);
  }, [activeSourceId, entrySearch, libraryView, reload, resetEntryPages]);

  const selectSource = useCallback((sourceId?: string) => {
    navigateLibrary({ view: "all", sourceId, search: "" });
  }, [navigateLibrary]);

  const selectLibrary = useCallback((view: LibraryView) => {
    navigateLibrary({ view, sourceId: undefined, search: "" });
  }, [navigateLibrary]);

  const setEntrySearch = useCallback((search: string) => {
    if (!activeSourceId || search === entrySearch) return;
    navigateLibrary({ view: libraryView, sourceId: activeSourceId, search });
  }, [activeSourceId, entrySearch, libraryView, navigateLibrary]);

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

  const clearActiveSource = useCallback(() => {
    navigateLibrary({ view: libraryView, sourceId: undefined, search: "" });
  }, [libraryView, navigateLibrary]);

  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const activeSource = activeSourceId ? sourceById.get(activeSourceId) : undefined;
  const sourceGroups = useMemo(() => groupSources(sources), [sources]);

  return {
    sources,
    entries,
    hasMoreEntries: Boolean(nextEntryCursor),
    loadingMoreEntries,
    reloadError,
    clearReloadError: () => setReloadError(undefined),
    libraryCounts,
    activeSourceId,
    libraryView,
    entrySearch,
    sourceById,
    activeSource,
    sourceGroups,
    reload,
    loadMoreEntries,
    selectSource,
    selectLibrary,
    setEntrySearch,
    clearActiveSource
  };
}
