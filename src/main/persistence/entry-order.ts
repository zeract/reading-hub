import type { Entry, EntryPageCursor } from "../../shared/types";

/** The query comparator and its expression indexes must evolve together.
 * Any ordering change requires a schema migration rebuilding those indexes.
 * Unqualified columns allow the same SQL in ORDER BY and CREATE INDEX. */
const NULL_PUBLICATION_CURSOR_VALUE = Number.MIN_SAFE_INTEGER;
export const ENTRY_ORDER_BY = "timeline_group DESC, timeline_published DESC, timeline_observed DESC, created_at DESC, id DESC";

export function entryPageCursor(entry: Entry): EntryPageCursor {
  return {
    ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
    observedAt: entry.observedAt ?? entry.createdAt,
    createdAt: entry.createdAt,
    id: entry.id
  };
}

export function afterEntryCursor(cursor: EntryPageCursor): { sql: string; parameters: Array<string | number> } {
  return {
    // Virtual columns expose the nullable timestamp expressions as seekable
    // index keys. All keys descend; a missing publication remains last.
    sql: "(timeline_group, timeline_published, timeline_observed, entries.created_at, entries.id) < (?, ?, ?, ?, ?)",
    parameters: [cursor.publishedAt === undefined ? 0 : 1, cursor.publishedAt ?? NULL_PUBLICATION_CURSOR_VALUE,
      cursor.observedAt, cursor.createdAt, cursor.id]
  };
}
