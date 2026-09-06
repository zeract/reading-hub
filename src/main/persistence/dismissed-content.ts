import type Database from "better-sqlite3";
import { canonicalizeContentUrl, isScourRssRedirectUrl } from "../../shared/url";

/** Call inside the same transaction that rekeys or merges the content rows. */
export function rekeyDismissedContent(database: Database.Database, previous: string[], identity: string): void {
  const find = database.prepare("SELECT dismissed_at FROM dismissed_contents WHERE canonical_identity = ?");
  const identities = [...new Set([...previous, identity])];
  const timestamps = identities.flatMap((key) => {
    const row = find.get(key) as { dismissed_at: number } | undefined;
    return row ? [row.dismissed_at] : [];
  });
  if (!timestamps.length) return;
  database.prepare(`INSERT INTO dismissed_contents (canonical_identity, dismissed_at) VALUES (?, ?)
    ON CONFLICT(canonical_identity) DO UPDATE SET dismissed_at = MAX(dismissed_contents.dismissed_at, excluded.dismissed_at)`)
    .run(identity, Math.max(...timestamps));
  const removeUnused = database.prepare(`DELETE FROM dismissed_contents WHERE canonical_identity = ?
    AND NOT EXISTS (SELECT 1 FROM entries WHERE COALESCE(canonical_identity, canonical_url) = ?)`);
  for (const key of identities) if (key !== identity) removeUnused.run(key, key);
}

/** Recover tombstones left behind by older Scour URL repairs, including absent cards. */
export function normalizeLegacyDismissedIdentities(database: Database.Database): void {
  const rows = database.prepare("SELECT canonical_identity FROM dismissed_contents").all() as Array<{ canonical_identity: string }>;
  for (const row of rows) {
    let canonical: string;
    try {
      if (!isScourRssRedirectUrl(row.canonical_identity)) continue;
      canonical = canonicalizeContentUrl(row.canonical_identity);
    } catch { continue; }
    if (canonical !== row.canonical_identity) rekeyDismissedContent(database, [row.canonical_identity], canonical);
  }
}
