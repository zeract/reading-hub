import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, EntryPageCursor, LibraryCounts, Source } from "../shared/types";
import { firstEntryPageQuery, mergeEntryPages, nextEntryPageQuery } from "./entry-pagination";
import { entryQueryForLibrary, type LibraryView } from "./library-view";
import { groupSources } from "./source-groups";
import { requiresSourceReload } from "./source-selection";

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
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [libraryView, setLibraryView] = useState<LibraryView>("today");
  const [entrySearch, setEntrySearchState] = useState("");
  const reloadSequence = useRef(0);
  const pageGeneration = useRef(0);
  const loadedBeyondFirstPage = useRef(false);
  const loadingMore = useRef(false);

  const entriesQuery = useMemo(
    () => entryQueryForLibrary(libraryView, activeSourceId, new Date(), entrySearch),
    [activeSourceId, entrySearch, libraryView]
  );
  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const generation = pageGeneration.current;
    const [nextSources, nextPage, nextLibraryCounts] = await Promise.all([
      window.reader.listSources(),
      window.reader.listEntryPage(firstEntryPageQuery(entriesQuery)),
      window.reader.getLibraryCounts()
    ]);
    if (sequence !== reloadSequence.current || generation !== pageGeneration.current) return;
    setSources(nextSources);
    setEntries((current) => loadedBeyondFirstPage.current ? mergeEntryPages(nextPage.entries, current) : nextPage.entries);
    if (!loadedBeyondFirstPage.current) setNextEntryCursor(nextPage.nextCursor);
    setLibraryCounts(nextLibraryCounts);
  }, [entriesQuery]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const resetEntryPages = useCallback(() => {
    pageGeneration.current += 1;
    loadedBeyondFirstPage.current = false;
    loadingMore.current = false;
    setLoadingMoreEntries(false);
    setNextEntryCursor(undefined);
    setEntries([]);
  }, []);

  const selectSource = useCallback((sourceId?: string) => {
    setLibraryView("all");
    if (requiresSourceReload(activeSourceId, sourceId)) {
      // A repeated click does not change activeSourceId, so the query effect
      // cannot initiate a fresh request by itself.
      void reload();
      return;
    }
    resetEntryPages();
    setEntrySearchState("");
    setActiveSourceId(sourceId);
  }, [activeSourceId, reload, resetEntryPages]);

  const selectLibrary = useCallback((view: LibraryView) => {
    resetEntryPages();
    setEntrySearchState("");
    setActiveSourceId(undefined);
    setLibraryView(view);
  }, [resetEntryPages]);

  const setEntrySearch = useCallback((search: string) => {
    if (!activeSourceId || search === entrySearch) return;
    resetEntryPages();
    setEntrySearchState(search);
  }, [activeSourceId, entrySearch, resetEntryPages]);

  const loadMoreEntries = useCallback(async () => {
    const cursor = nextEntryCursor;
    if (!cursor || loadingMore.current) return;
    const generation = pageGeneration.current;
    loadingMore.current = true;
    setLoadingMoreEntries(true);
    try {
      const nextPage = await window.reader.listEntryPage(nextEntryPageQuery(entriesQuery, cursor));
      if (generation !== pageGeneration.current) return;
      setEntries((current) => mergeEntryPages(current, nextPage.entries));
      setNextEntryCursor(nextPage.nextCursor);
      loadedBeyondFirstPage.current = true;
    } finally {
      if (generation === pageGeneration.current) {
        loadingMore.current = false;
        setLoadingMoreEntries(false);
      }
    }
  }, [entriesQuery, nextEntryCursor]);

  const clearActiveSource = useCallback(() => {
    resetEntryPages();
    setEntrySearchState("");
    setActiveSourceId(undefined);
  }, [resetEntryPages]);

  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const activeSource = activeSourceId ? sourceById.get(activeSourceId) : undefined;
  const sourceGroups = useMemo(() => groupSources(sources), [sources]);

  return {
    sources,
    entries,
    hasMoreEntries: Boolean(nextEntryCursor),
    loadingMoreEntries,
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
