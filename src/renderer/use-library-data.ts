import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, LibraryCounts, Source } from "../shared/types";
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
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [libraryView, setLibraryView] = useState<LibraryView>("today");
  const reloadSequence = useRef(0);

  const entriesQuery = useMemo(() => entryQueryForLibrary(libraryView, activeSourceId), [activeSourceId, libraryView]);
  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    const [nextSources, nextEntries, nextLibraryCounts] = await Promise.all([
      window.reader.listSources(),
      window.reader.listEntries(entriesQuery),
      window.reader.getLibraryCounts()
    ]);
    if (sequence !== reloadSequence.current) return;
    setSources(nextSources);
    setEntries(nextEntries);
    setLibraryCounts(nextLibraryCounts);
  }, [entriesQuery]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const selectSource = useCallback((sourceId?: string) => {
    setLibraryView("all");
    if (requiresSourceReload(activeSourceId, sourceId)) {
      // A repeated click does not change activeSourceId, so the query effect
      // cannot initiate a fresh request by itself.
      void reload();
      return;
    }
    setEntries([]);
    setActiveSourceId(sourceId);
  }, [activeSourceId, reload]);

  const selectLibrary = useCallback((view: LibraryView) => {
    setActiveSourceId(undefined);
    setLibraryView(view);
    setEntries([]);
  }, []);

  const clearActiveSource = useCallback(() => {
    setActiveSourceId(undefined);
  }, []);

  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const activeSource = activeSourceId ? sourceById.get(activeSourceId) : undefined;
  const sourceGroups = useMemo(() => groupSources(sources), [sources]);

  return {
    sources,
    entries,
    libraryCounts,
    activeSourceId,
    libraryView,
    sourceById,
    activeSource,
    sourceGroups,
    reload,
    selectSource,
    selectLibrary,
    clearActiveSource
  };
}
