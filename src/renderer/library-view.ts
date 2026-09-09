import type { EntryListQuery } from "../shared/types";

export type LibraryView = "all" | "today" | "unread" | "favorite";

/**
 * Today and a selected source can be scoped to one source. Library-state views
 * such as unread are intentionally global, so a stale source selection can
 * never hide unread cards from another subscription.
 */
export function entryQueryForLibrary(view: LibraryView, sourceId?: string, now = new Date(), sourceSearch?: string): EntryListQuery {
  const search = sourceSearch?.trim() ? { search: sourceSearch } : {};
  if (view === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { sourceId, ...search, startAt: start.getTime(), endAt: end.getTime(), publishedOrCollected: true };
  }
  // Reading-state filters belong in the database query rather than the first
  // client page. Otherwise an old unread/saved item could disappear simply
  // because newer unrelated entries filled the initial page.
  if (view === "unread") return { sourceId: undefined, ...search, read: false };
  if (view === "favorite") return { sourceId, ...search, favorite: true };
  return { sourceId, ...search };
}
