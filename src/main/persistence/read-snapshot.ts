import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Audits may migrate their own copy, never the live library they inspect. */
export async function createReadSnapshot(filePath: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "reading-hub-read-snapshot-"));
  const snapshotPath = join(directory, "library.sqlite");
  let original: Database.Database | undefined;
  try {
    original = new Database(filePath, { readonly: true, fileMustExist: true });
    // SQLite's backup API includes committed WAL state and provides a coherent
    // copy even when the app's scheduler is writing concurrently.
    await original.backup(snapshotPath);
    return { path: snapshotPath, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    original?.close();
  }
}
