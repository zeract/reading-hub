import type { EntryListQuery } from "../shared/types";

export type LibraryView = "all" | "today" | "unread" | "favorite";

/**
 * Today and a selected source can be scoped to one source. Library-state views
 * such as unread are intentionally global, so a stale source selection can
 * never hide unread cards from another subscription.
 */
export function entryQueryForLibrary(view: LibraryView, sourceId?: string, now = new Date()): EntryListQuery {
  if (view === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { sourceId, startAt: start.getTime(), endAt: end.getTime() };
  }
  if (view === "unread") return { sourceId: undefined };
  // Saved items may still be examined inside an individual source. The default
  // all-items view stays bounded for responsiveness.
  return { sourceId, ...(view === "all" ? { limit: 200 } : {}) };
}
