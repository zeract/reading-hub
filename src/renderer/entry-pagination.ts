import type { Entry, EntryListQuery, EntryPageCursor, EntryPageQuery } from "../shared/types";

/** A small page keeps the three-column desktop layout responsive on large feeds. */
export const ENTRY_PAGE_SIZE = 100;

export function firstEntryPageQuery(query: EntryListQuery): EntryPageQuery {
  return { ...query, pageSize: ENTRY_PAGE_SIZE };
}

export function nextEntryPageQuery(query: EntryListQuery, cursor: EntryPageCursor): EntryPageQuery {
  return { ...firstEntryPageQuery(query), cursor };
}

/**
 * Revalidation may add newer cards while an older history page is on screen.
 * Preserve display order from the first array and retain only one instance of
 * each content card, rather than resetting the reader to the first page.
 */
export function mergeEntryPages(first: Entry[], second: Entry[]): Entry[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}
