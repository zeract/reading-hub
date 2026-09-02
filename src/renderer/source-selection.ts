import type { LibraryView } from "./library-view";

/**
 * The complete local query scope represented by a navigation action.
 *
 * React intentionally bails out when every state setter receives its current
 * value. A repeated navigation therefore cannot rely on the query effect to
 * reload. Keeping all query-shaping state here prevents source and library
 * navigation from drifting into separate, subtly different implementations.
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
