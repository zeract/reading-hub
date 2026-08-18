import type { EntryListQuery } from "../shared/types";

export type LibraryView = "all" | "today" | "unread" | "favorite";

/**
 * The inbox intentionally exposes only the useful chronological view: today.
 * Other views load their cards once and apply their local reading-state filter.
 */
export function entryQueryForLibrary(view: LibraryView, sourceId?: string, now = new Date()): EntryListQuery {
  if (view === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { sourceId, startAt: start.getTime(), endAt: end.getTime() };
  }
  // An explicitly state-filtered inbox must not silently drop older unread or
  // saved items. The default all-items view stays bounded for responsiveness.
  return { sourceId, ...(view === "all" ? { limit: 200 } : {}) };
}
