import type { Entry, EntryListQuery, EntryPage, EntryPageCursor, EntryPageQuery } from "../shared/types";

/** A small page keeps the three-column desktop layout responsive on large feeds. */
export const ENTRY_PAGE_SIZE = 100;

export function firstEntryPageQuery(query: EntryListQuery): EntryPageQuery {
  return { ...query, pageSize: ENTRY_PAGE_SIZE };
}

export function nextEntryPageQuery(query: EntryListQuery, cursor: EntryPageCursor): EntryPageQuery {
  return { ...firstEntryPageQuery(query), cursor };
}

/** Re-read the visible range through bounded IPC pages instead of retaining stale history. */
export async function readLoadedEntryPages(
  query: EntryListQuery,
  pageCount: number,
  readPage: (query: EntryPageQuery) => Promise<EntryPage>,
  isCurrent: () => boolean
): Promise<(EntryPage & { pageCount: number }) | undefined> {
  let entries: Entry[] = [];
  let cursor: EntryPageCursor | undefined;
  let loaded = 0;
  do {
    if (!isCurrent()) return undefined;
    const page = await readPage(cursor ? nextEntryPageQuery(query, cursor) : firstEntryPageQuery(query));
    if (!isCurrent()) return undefined;
    entries = mergeEntryPages(entries, page.entries);
    cursor = page.nextCursor;
    loaded += 1;
  } while (cursor && loaded < pageCount);
  return { entries, nextCursor: cursor, pageCount: loaded };
}

/**
 * Adjacent pages can overlap when content arrives between IPC requests.
 * Preserve their order and retain only one instance of each content card.
 */
export function mergeEntryPages(first: Entry[], second: Entry[]): Entry[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}
