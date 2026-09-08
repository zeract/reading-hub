import type { LibraryView } from "./library-view";

/**
 * The complete local query scope represented by a navigation action.
 *
 * Repeated navigation leaves this selection unchanged, so it cannot rely on
 * the query effect to reload. Keeping all query-shaping state together lets
 * retained callbacks read the latest accepted navigation and prevents source
 * and library navigation from drifting into different implementations.
 */
export interface LibrarySelection {
  view: LibraryView;
  sourceId?: string;
  search: string;
}

/** Whether applying a navigation target would leave the effective query unchanged. */
export function isSameLibrarySelection(current: LibrarySelection, requested: LibrarySelection): boolean {
  return current.view === requested.view
    && current.sourceId === requested.sourceId
    && current.search === requested.search;
}
