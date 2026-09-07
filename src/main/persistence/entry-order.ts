import type { Entry, EntryPageCursor } from "../../shared/types";

/** The query comparator and its expression indexes must evolve together.
 * Any ordering change requires a schema migration rebuilding those indexes.
 * Unqualified columns allow the same SQL in ORDER BY and CREATE INDEX. */
const NULL_PUBLICATION_CURSOR_VALUE = Number.MIN_SAFE_INTEGER;
const ENTRY_PUBLICATION_GROUP = "CASE WHEN published_at IS NULL THEN 1 ELSE 0 END";
const ENTRY_PUBLICATION_VALUE = `COALESCE(published_at, ${NULL_PUBLICATION_CURSOR_VALUE})`;
const ENTRY_OBSERVED_VALUE = "COALESCE(observed_at, created_at)";
export const ENTRY_ORDER_BY = `${ENTRY_PUBLICATION_GROUP} ASC, ${ENTRY_PUBLICATION_VALUE} DESC, ${ENTRY_OBSERVED_VALUE} DESC, created_at DESC, id DESC`;

export function entryPageCursor(entry: Entry): EntryPageCursor {
  return {
    ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
    observedAt: entry.observedAt ?? entry.createdAt,
    createdAt: entry.createdAt,
    id: entry.id
  };
}

export function afterEntryCursor(cursor: EntryPageCursor): { sql: string; parameters: Array<string | number> } {
  const publicationGroup = cursor.publishedAt === undefined ? 1 : 0;
  const publicationValue = cursor.publishedAt ?? NULL_PUBLICATION_CURSOR_VALUE;
  return {
    // The comparison is the exact inverse of ENTRY_ORDER_BY.  Keeping every
    // tie-breaker here makes continuation stable even when many old feed
    // items share a publication time or have no publication date at all.
    sql: `(
      ${ENTRY_PUBLICATION_GROUP} > ?
      OR (${ENTRY_PUBLICATION_GROUP} = ? AND (
        ${ENTRY_PUBLICATION_VALUE} < ?
        OR (${ENTRY_PUBLICATION_VALUE} = ? AND (
          ${ENTRY_OBSERVED_VALUE} < ?
          OR (${ENTRY_OBSERVED_VALUE} = ? AND (
            entries.created_at < ?
            OR (entries.created_at = ? AND entries.id < ?)
          ))
        ))
      ))
    )`,
    parameters: [
      publicationGroup,
      publicationGroup,
      publicationValue,
      publicationValue,
      cursor.observedAt,
      cursor.observedAt,
      cursor.createdAt,
      cursor.createdAt,
      cursor.id
    ]
  };
}
